import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeEnv, fakeKv, withFetch, type FetchCall, type Route } from "./fakes.ts";
import { gatherFindings, owningCheck, WATCHER_CHECKS, type Finding, type WatcherCheck } from "../src/watcher.ts";
import { parseOnPurpose, suggestNamespace } from "../src/unmapped-repos.ts";

// The unmapped-repo check (job_1e2df2bba342), driven through gatherFindings with a real
// App JWT and fake GitHub routes. A repo is reachable through Capsid only if a namespace
// maps it, so the check must find the ones that none does, must not map anything, and
// must say so when it cannot read the list.

const OWNER = "DrDustinEdwards";

// A real RSA key, so createAppJwt signs for real. Generated once.
let pem: string | null = null;
async function privateKeyPem(): Promise<string> {
  if (pem) return pem;
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return pem;
}

type NsRow = { namespace: string; repos: string };
const ns = (namespace: string, ...repos: string[]): NsRow => ({
  namespace,
  repos: JSON.stringify(repos.map((repo, i) => ({ repo: `${OWNER}/${repo}`, label: i === 0 ? "primary" : `r${i}` }))),
});

// Answers exactly what the check reads; anything else throws, which gatherFindings'
// other checks turn into a skipped check.
function db(rows: NsRow[], onPurposeDoc: string | null = null) {
  const stmt = (sql: string) => {
    const result = async () => {
      if (sql.includes("FROM namespaces")) return { results: rows };
      throw new Error(`fake D1 has no rows for: ${sql.slice(0, 60)}`);
    };
    const first = async () => {
      if (sql.includes("FROM documents WHERE namespace = ?1 AND path = ?2")) return onPurposeDoc === null ? null : { body: onPurposeDoc };
      throw new Error(`fake D1 has no answer for: ${sql.slice(0, 60)}`);
    };
    const bound = { first, all: result, run: result };
    return { ...bound, bind: () => bound };
  };
  return { prepare: stmt };
}

const repo = (name: string, over: Partial<{ private: boolean; archived: boolean; pushed_at: string | null }> = {}) => ({
  full_name: `${OWNER}/${name}`,
  private: false,
  archived: false,
  pushed_at: "2026-10-04T10:00:00Z",
  ...over,
});

function appRoutes(repos: ReturnType<typeof repo>[]): Record<string, Route> {
  return {
    "GET /app/installations": { body: [{ id: 111 }] },
    "POST /app/installations/111/access_tokens": { body: { token: "metadata-only-token" } },
    "GET /installation/repositories": { body: { total_count: repos.length, repositories: repos } },
  };
}

async function gather(
  rows: NsRow[],
  routes: Record<string, Route>,
  onPurposeDoc: string | null = null
): Promise<{ found: Finding[]; ran: ReadonlySet<WatcherCheck>; calls: FetchCall[]; failures: string[] }> {
  const env = fakeEnv({
    DB: db(rows, onPurposeDoc),
    APP_KV: fakeKv({ seedToken: true }).kv,
    GITHUB_APP_CLIENT_ID: "app",
    GITHUB_APP_PRIVATE_KEY: await privateKeyPem(),
  });
  const failures: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    failures.push(args.map(String).join(" "));
  };
  let found: Finding[] = [];
  let ran: ReadonlySet<WatcherCheck> = new Set();
  let calls: FetchCall[] = [];
  try {
    await withFetch(routes, async (made) => {
      calls = made;
      ({ findings: found, ran } = await gatherFindings(env, new Date("2026-10-04T12:00:00Z")));
    });
  } finally {
    console.error = original;
  }
  return { found, ran, calls, failures };
}

const unmapped = (found: Finding[]) => found.filter((f) => f.fingerprint.startsWith("unmapped-repo"));

const MAPPED = [ns("capsid", "capsid", "capsid-backups"), ns("foxing", "foxing", "foxing-admin-mcp")];

test("PLANT: one installed repo that no namespace maps is exactly one finding, naming it and a likely namespace", async () => {
  const { found, ran } = await gather(MAPPED, appRoutes([repo("capsid"), repo("capsid-backups"), repo("foxing"), repo("foxing-admin-mcp"), repo("foxing-extras", { private: true })]));
  const out = unmapped(found);
  assert.equal(out.length, 1, JSON.stringify(out.map((f) => f.fingerprint)));
  assert.equal(out[0].fingerprint, "unmapped-repo-drdustinedwards--foxing-extras");
  assert.match(out[0].title, /DrDustinEdwards\/foxing-extras is visible to the GitHub App but no namespace maps it/);
  assert.ok((out[0].evidence ?? []).some((l) => /private, not archived, last push 2026-10-04/.test(l)), JSON.stringify(out[0].evidence));
  assert.ok((out[0].evidence ?? []).some((l) => /likely namespace: foxing/.test(l)), JSON.stringify(out[0].evidence));
  // What it read is on the finding, so a clear pass cannot be 0 over 0.
  assert.ok((out[0].evidence ?? []).some((l) => /list 5 repos; 4 are mapped/.test(l)), JSON.stringify(out[0].evidence));
  assert.ok(ran.has("repo map"));
});

test("PLANT: a repo named in the unmapped-on-purpose document is not a finding, and the others still are", async () => {
  const doc = "# frozen\nDrDustinEdwards/Old-Advisory-Database  # archived\n";
  const { found, ran } = await gather(MAPPED, appRoutes([repo("capsid"), repo("old-advisory-database", { archived: true }), repo("loose-repo")]), doc);
  assert.deepEqual(unmapped(found).map((f) => f.fingerprint), ["unmapped-repo-drdustinedwards--loose-repo"]);
  assert.ok(ran.has("repo map"));
});

test("a repo that is mapped, whatever the case, is not a finding, and a clean pass says it read the list", async () => {
  const { found, ran, failures } = await gather(MAPPED, appRoutes([{ ...repo("CAPSID") }, repo("foxing-admin-mcp")]));
  assert.deepEqual(unmapped(found), []);
  assert.ok(ran.has("repo map"), "a clean read did not count as the check having run");
  assert.deepEqual(failures.filter((f) => f.includes("repo map")), []);
});

test("PLANT: an unreadable installation list fails closed with a finding saying so, and the check is not counted as run", async () => {
  const { found, ran } = await gather(MAPPED, { ...appRoutes([repo("capsid")]), "GET /app/installations": { status: 500, body: { message: "boom" } } });
  const out = unmapped(found);
  assert.deepEqual(out.map((f) => f.fingerprint), ["unmapped-repos-unreadable"]);
  assert.match((out[0].evidence ?? []).join(" "), /could not list the App's installations \(500\)/);
  assert.ok(!ran.has("repo map"), "an open unmapped-repo finding would be cleared on no evidence");
});

test("PLANT: an App that lists no repositories is not read as 'nothing unmapped'", async () => {
  const { found, ran } = await gather(MAPPED, appRoutes([]));
  assert.deepEqual(unmapped(found).map((f) => f.fingerprint), ["unmapped-repos-unreadable"]);
  assert.match((unmapped(found)[0].evidence ?? []).join(" "), /no repositories at all/);
  assert.ok(!ran.has("repo map"));
});

test("a list read in part (the count says more than came back) is unreadable, not complete", async () => {
  const routes = appRoutes([repo("capsid")]);
  // GitHub said 3 and delivered 1: the second page is empty.
  routes["GET /installation/repositories"] = (_body, search) => ({
    body: { total_count: 3, repositories: search.get("page") === "1" ? [repo("capsid")] : [] },
  });
  const { found } = await gather(MAPPED, routes);
  assert.deepEqual(unmapped(found).map((f) => f.fingerprint), ["unmapped-repos-unreadable"]);
  assert.match((unmapped(found)[0].evidence ?? []).join(" "), /listed 1 of 3/);
});

test("a corrupt namespace mapping makes the check unreadable instead of treating its repos as unmapped", async () => {
  const { found, ran } = await gather([...MAPPED, { namespace: "broken", repos: "{not json" }], appRoutes([repo("capsid")]));
  assert.deepEqual(unmapped(found).map((f) => f.fingerprint), ["unmapped-repos-unreadable"]);
  assert.match((unmapped(found)[0].evidence ?? []).join(" "), /broken has a corrupt repos mapping/);
  assert.ok(!ran.has("repo map"));
});

test("the token minted to list repos is limited to metadata:read, and the check maps nothing", async () => {
  const { calls } = await gather(MAPPED, appRoutes([repo("capsid"), repo("loose-repo")]));
  const mint = calls.find((c) => c.method === "POST" && c.path === "/app/installations/111/access_tokens");
  assert.deepEqual(mint?.body, { permissions: { metadata: "read" } }, "the listing token was not limited to metadata:read");
  const writes = calls.filter((c) => c.method !== "GET" && c.path !== "/app/installations/111/access_tokens");
  assert.deepEqual(writes, [], "the check wrote to GitHub");
});

test("every unmapped-repo fingerprint belongs to the repo map check, so a read clears only its own findings", () => {
  assert.ok((WATCHER_CHECKS as readonly string[]).includes("repo map"));
  assert.equal(owningCheck("unmapped-repo-drdustinedwards--x"), "repo map");
  assert.equal(owningCheck("unmapped-repos-unreadable"), "repo map");
});

test("suggestNamespace: a namespace named for the repo, else the longest dashed prefix, else none", () => {
  const all = ["capsid", "claude-skills", "claude", "foxing"];
  assert.equal(suggestNamespace(`${OWNER}/foxing`, all), "foxing");
  assert.equal(suggestNamespace(`${OWNER}/Foxing-Admin-MCP`, all), "foxing");
  assert.equal(suggestNamespace(`${OWNER}/claude-skills-private`, all), "claude-skills");
  assert.equal(suggestNamespace(`${OWNER}/capsidal`, all), null, "a prefix without the dash matched");
  assert.equal(suggestNamespace(`${OWNER}/site-api`, all), null);
});

test("parseOnPurpose reads owner/name lines, drops comments and anything else", () => {
  const set = parseOnPurpose("# header\nA/B  # why\n\nnot a repo\nC/D\n../x\n");
  assert.deepEqual([...set].sort(), ["a/b", "c/d"]);
  assert.deepEqual([...parseOnPurpose(null)], []);
});
