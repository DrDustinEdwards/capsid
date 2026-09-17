import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeEnv, fakeKv, withFetch, type Route } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";
import { gatherFindings, type Finding } from "../src/watcher.ts";

// THE WATCHER'S TWO HEALTH CHECKS NEVER RAN (AUDIT-2026-09-16.md, 8.1 and 8.21).
//
// healthFindings was tested as a pure function and was correct. What was wrong was
// the gathering in front of it: the master head read called repoHistory with no ref,
// which throws, and the migrations read took `name` from listRepoTree entries, which
// carry `path`. attempt() swallowed the first and the cast hid the second, so both
// checks received null and reported nothing, every half hour, from the day they
// shipped. These tests drive gatherFindings itself, through the real repo readers,
// so the property under test is "the finding reaches the queue", not "the judgement
// is right when handed the right input".

const OWNER = "DrDustinEdwards";
const REPO = "capsid";
const MASTER = "a".repeat(40);
const DEPLOYED = "b".repeat(40);
const LIVE_SCHEMA = "0015_outcome_prs.sql";
const NEWER = "0016_jobs_retry_cap.sql";

// A D1 that answers exactly the queries /health and resolveRepo make, and throws on
// anything else. Everything else gatherFindings reads (improve_status, blocked jobs)
// fails into attempt(), which is the path a real outage takes, so those checks are
// absent from the result rather than faked.
function healthDb(schema: string, repos = [{ repo: `${OWNER}/${REPO}`, label: "primary" }]) {
  const stmt = (sql: string) => {
    const first = async () => {
      if (sql.includes("SELECT 1 AS ok")) return { ok: 1 };
      if (sql.includes("documents_fts")) return { path: "conventions.md" };
      if (sql.includes("d1_migrations")) return { name: schema };
      if (sql.includes("FROM namespaces")) return { repos: JSON.stringify(repos) };
      throw new Error(`fake D1 has no answer for: ${sql.slice(0, 60)}`);
    };
    const all = async () => {
      throw new Error(`fake D1 has no rows for: ${sql.slice(0, 60)}`);
    };
    const bound = { first, all, run: all };
    return { ...bound, bind: () => bound };
  };
  return { prepare: stmt };
}

function env(schema: string, repos?: Array<{ repo: string; label: string }>) {
  const kv = fakeKv({ seedToken: true, seed: { "backup:last-ok": new Date().toISOString() } });
  return fakeEnv({
    DB: healthDb(schema, repos),
    APP_KV: kv.kv,
    BUILD_SHA: DEPLOYED,
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
  });
}

// GitHub as the real readers ask for it. The commits route is served too, so a
// watcher that reads master head through repo_history with a ref is not failed by
// the harness.
const commit = (sha: string) => ({ sha, commit: { message: "m", author: { name: "a", date: "2026-09-16T00:00:00Z" } } });
const entry = (name: string) => ({ path: `migrations/${name}`, type: "file", size: 1, sha: "c".repeat(40) });
const routes: Record<string, Route> = {
  [`GET /repos/${OWNER}/${REPO}`]: { body: { default_branch: "master" } },
  [`GET /repos/${OWNER}/${REPO}/git/ref/heads/master`]: { body: { object: { sha: MASTER } } },
  [`GET /repos/${OWNER}/${REPO}/commits`]: { body: [commit(MASTER)] },
  [`GET /repos/${OWNER}/${REPO}/contents/migrations`]: { body: [entry(LIVE_SCHEMA), entry(NEWER), { ...entry("README.md") }] },
};

async function gather(
  schema: string,
  repos?: Array<{ repo: string; label: string }>,
  extra: Record<string, Route> = {}
): Promise<{ found: Finding[]; failures: string[] }> {
  const failures: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    failures.push(args.map(String).join(" "));
  };
  let found: Finding[] = [];
  try {
    await withFetch({ ...routes, ...extra }, async () => {
      found = await gatherFindings(env(schema, repos), new Date());
    });
  } finally {
    console.error = original;
  }
  return { found, failures };
}

const fingerprints = (found: Finding[]) => found.map((f) => f.fingerprint);

test("A DEPLOYED SHA THAT IS NOT MASTER HEAD REACHES THE QUEUE through gatherFindings", async () => {
  const { found, failures } = await gather(NEWER);
  assert.ok(
    fingerprints(found).includes(`deploy-drift-${MASTER.slice(0, 7)}`),
    `no deploy-drift finding; read failures: ${failures.filter((f) => f.includes("master head")).join(" | ") || "none"}`
  );
  assert.deepEqual(failures.filter((f) => f.includes("master head")), [], "the master head read must not fail");
});

test("A LIVE SCHEMA BEHIND THE NEWEST MIGRATION REACHES THE QUEUE through gatherFindings", async () => {
  const { found, failures } = await gather(LIVE_SCHEMA);
  assert.ok(
    fingerprints(found).includes(`schema-behind-${NEWER}`),
    `no schema-behind finding; got ${JSON.stringify(fingerprints(found))}`
  );
  assert.deepEqual(failures.filter((f) => f.includes("migrations")), [], "the migrations read must not fail");
});

// THE FIELD CONTRACT. The watcher reads repo-reader results with no cast, so the
// field names it uses are checked by `npm run check` against what the readers
// actually return: planted 2026-09-17 by renaming listRepoTree's `path` to `name`,
// which failed tsc at both watcher reads and failed the schema test above. A cast
// such as `(tree as { entries?: Array<{ name?: string }> })` is what turned that
// rename into silence, so this guard refuses any cast in the file's code at all.
// The count is stated so the scan cannot pass by matching nothing.
const READERS = ["defaultBranchSha", "listRepoTree", "readRepoFile", "ciStatus"];
const EXPECTED_READER_CALLS = 7;

// scanner-rule: AUDIT-2026-09-16 items 8.1 and 8.21, reader results keep their types
test("the watcher reads every repo reader's result through its real type, never a cast", () => {
  const code = sourceFile("watcher.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const calls = READERS.flatMap((r) => code.match(new RegExp(`\\b${r}\\(env`, "g")) ?? []);
  assert.equal(calls.length, EXPECTED_READER_CALLS, `repo reader calls in src/watcher.ts: ${calls.join(", ")}`);
  assert.doesNotMatch(code, /\bas\s+(\{|Array<|[A-Z]\w*(\[\]|<))/, "src/watcher.ts casts a value; read it through its inferred type");
  // repoHistory is the reader that threw on every pass. The head is defaultBranchSha.
  assert.doesNotMatch(code, /\brepoHistory\b/);
});

test("a live schema AT the newest migration is not a finding, so the check is not just always firing", async () => {
  const { found } = await gather(NEWER);
  assert.ok(!fingerprints(found).some((f) => f.startsWith("schema-behind-")), JSON.stringify(fingerprints(found)));
});

// THE MIRROR CHECK IS GATED ON ITS DUMP LISTING. "Cannot see the mirror" and "the
// mirror is dead" are different facts, and posting the second during a GitHub outage
// would file a job every half hour.
const BACKUPS = [
  { repo: `${OWNER}/${REPO}`, label: "primary" },
  { repo: `${OWNER}/capsid-backups`, label: "backups" },
];
const BACKUPS_REPO = { [`GET /repos/${OWNER}/capsid-backups`]: { body: { default_branch: "main" } } };

test("an unreadable mirror listing posts nothing about the mirror", async () => {
  const { found, failures } = await gather(NEWER, BACKUPS, {
    ...BACKUPS_REPO,
    [`GET /repos/${OWNER}/capsid-backups/contents/backups/json`]: { status: 500, body: { message: "boom" } },
  });
  assert.ok(failures.some((f) => f.includes("mirror dumps")), "the dump listing did not fail, so this proves nothing");
  assert.deepEqual(fingerprints(found).filter((f) => f.startsWith("mirror-")), [], "an unreadable mirror was reported as a dead one");
});

test("a readable, empty mirror listing is the no-dump finding", async () => {
  const { found } = await gather(NEWER, BACKUPS, {
    ...BACKUPS_REPO,
    [`GET /repos/${OWNER}/capsid-backups/contents/backups/json`]: { body: [] },
  });
  assert.ok(fingerprints(found).includes("mirror-no-dump"), `no mirror-no-dump finding: ${fingerprints(found).join(", ")}`);
});
