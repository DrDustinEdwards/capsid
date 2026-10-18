import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STALE_STEPS_KEY,
  checkManualSteps,
  liveStepReaders,
  parseStep,
  parseStepCache,
  stepState,
  stepsNamed,
  stepsSeen,
  tallySteps,
  type StepReaders,
} from "../src/manual-steps.ts";
import { blockSettled } from "../src/inbox.ts";
import { classifyStale } from "../src/stale-jobs.ts";
import { readAccessAppNames } from "../src/ops-cloudflare.ts";
import { npmVersions } from "../src/ops-packages.ts";
import type { StoredSecrets } from "../src/secret-presence.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// Dustin's manual steps as tracked items (improvement list item 14): the "check:" forms, the
// state each read gives a step, and how a job whose steps are all seen is settled in the
// inbox and listed in the stale view. Every form is driven to seen and to not seen, and
// every failed read to unread, so no check is only ever seen passing.

const BLOCKED_AT = "2026-10-10T10:00:00.000Z";
const READ_AT = "2026-10-10T11:00:00.000Z";
const job = { namespace: "sample", updated_at: BLOCKED_AT };

const secrets = (rows: Array<{ name: string; set: boolean }>, over: Partial<StoredSecrets> = {}): StoredSecrets => ({
  state: "ok",
  script: "sample-worker",
  rows: rows.map((r) => ({ ...r, expected: true })),
  reason: null,
  read_at: READ_AT,
  ...over,
});

function readers(over: Partial<StepReaders> = {}): StepReaders {
  return {
    secrets: async () => secrets([{ name: "API_KEY", set: true }]),
    npmVersions: async () => ["1.0.0", "1.2.0"],
    accessAppNames: async () => ["Sample Portal"],
    githubAbout: async () => ({ description: "A sample", homepage: "https://example.com/" }),
    ...over,
  };
}

const boom = async (): Promise<never> => {
  throw new Error("read failed");
};

test("each check form parses, and a line in no known form is unknown", () => {
  assert.deepEqual(parseStep("secret API_KEY on sample"), { kind: "secret", name: "API_KEY", namespace: "sample", text: "secret API_KEY on sample" });
  assert.deepEqual(parseStep("npm @example/kit@1.2.0"), { kind: "npm", name: "@example/kit", version: "1.2.0", text: "npm @example/kit@1.2.0" });
  assert.deepEqual(parseStep("npm kit@2.0.0-beta.1"), { kind: "npm", name: "kit", version: "2.0.0-beta.1", text: "npm kit@2.0.0-beta.1" });
  assert.deepEqual(parseStep("access app Sample Portal"), { kind: "access-app", name: "Sample Portal", text: "access app Sample Portal" });
  assert.deepEqual(parseStep("github about example-org/sample"), { kind: "github-about", repo: "example-org/sample", homepage: null, text: "github about example-org/sample" });
  assert.deepEqual(parseStep("github about example-org/sample homepage https://example.com"), {
    kind: "github-about",
    repo: "example-org/sample",
    homepage: "https://example.com",
    text: "github about example-org/sample homepage https://example.com",
  });
  for (const line of ["npm kit", "npm kit@latest", "secret API_KEY", "dns record example.com", "github about sample"]) {
    assert.equal(parseStep(line).kind, "unknown", line);
  }
});

test("only lines starting check: name a step, in the reason or the indented command, once each", () => {
  const summary = [
    "Set the key, then publish.",
    "1. Open the dashboard and add the secret.",
    "check: secret API_KEY on sample",
    "The secret is described in check: prose mid-line and is not a step.",
    "",
    "Run this, then send it back in with capsid_work_jobs action 'resume':",
    "",
    "    check: npm @example/kit@1.2.0",
    "CHECK: secret API_KEY on sample",
  ].join("\n");
  assert.deepEqual(
    stepsNamed(summary).map((s) => s.kind),
    ["secret", "npm"],
    "the keyword is not case sensitive, and a step named twice is one step"
  );
  assert.deepEqual(stepsNamed("Blocked: merge it. Run this: Merge https://github.com/example-org/sample/pull/1"), []);
});

test("a secret is seen once the stored names list it set, read after the job blocked", async () => {
  const step = parseStep("secret API_KEY on sample");
  assert.equal(await stepState(step, job, readers()), "seen");
  assert.equal(await stepState(step, job, readers({ secrets: async () => secrets([{ name: "API_KEY", set: false }]) })), "unseen");
  assert.equal(await stepState(step, job, readers({ secrets: async () => secrets([]) })), "unseen");
  assert.equal(await stepState(step, job, readers({ secrets: async () => secrets([{ name: "API_KEY", set: true }], { read_at: "2026-10-10T09:00:00.000Z" }) })), "unread", "read before it blocked");
  assert.equal(await stepState(step, job, readers({ secrets: async () => secrets([], { state: "error", reason: "403" }) })), "unread", "the read failed");
  assert.equal(await stepState(step, job, readers({ secrets: async () => null })), "unread", "no pass stored it");
});

test("an npm version is seen once npm lists it", async () => {
  assert.equal(await stepState(parseStep("npm @example/kit@1.2.0"), job, readers()), "seen");
  assert.equal(await stepState(parseStep("npm @example/kit@1.3.0"), job, readers()), "unseen");
  assert.equal(await stepState(parseStep("npm @example/kit@1.2.0"), job, readers({ npmVersions: async () => null })), "unseen", "no such package yet");
  assert.equal(await stepState(parseStep("npm @example/kit@1.2.0"), job, readers({ npmVersions: boom })), "unread");
});

test("an Access app is seen once one of that name exists, case aside", async () => {
  assert.equal(await stepState(parseStep("access app sample portal"), job, readers()), "seen");
  assert.equal(await stepState(parseStep("access app Other"), job, readers()), "unseen");
  assert.equal(await stepState(parseStep("access app Sample Portal"), job, readers({ accessAppNames: boom })), "unread");
});

test("a repo's About box is seen with a description and a homepage, that homepage when named", async () => {
  assert.equal(await stepState(parseStep("github about example-org/sample"), job, readers()), "seen");
  assert.equal(await stepState(parseStep("github about example-org/sample homepage https://example.com"), job, readers()), "seen", "a trailing slash aside");
  assert.equal(await stepState(parseStep("github about example-org/sample homepage https://example.org"), job, readers()), "unseen");
  assert.equal(await stepState(parseStep("github about example-org/sample"), job, readers({ githubAbout: async () => ({ description: "A sample", homepage: "" }) })), "unseen");
  assert.equal(await stepState(parseStep("github about example-org/sample"), job, readers({ githubAbout: async () => ({ description: null, homepage: "https://example.com" }) })), "unseen");
  assert.equal(await stepState(parseStep("github about example-org/sample"), job, readers({ githubAbout: boom })), "unread");
});

test("a step in no known form is unread, so it never settles a job", async () => {
  assert.equal(await stepState(parseStep("dns record example.com"), job, readers()), "unread");
});

test("every step seen settles; one unseen or unread, or none named, does not", () => {
  assert.equal(stepsSeen(tallySteps(["seen", "seen"], READ_AT)), true);
  assert.equal(stepsSeen(tallySteps(["seen", "unseen"], READ_AT)), false);
  assert.equal(stepsSeen(tallySteps(["seen", "unread"], READ_AT)), false);
  assert.equal(stepsSeen(tallySteps([], READ_AT)), false);
  assert.equal(stepsSeen(undefined), false);
});

test("the cache keeps entries of the right shape and reports the rest", () => {
  assert.deepEqual(parseStepCache(null), { cache: {}, problem: null });
  assert.match(parseStepCache("not json").problem ?? "", /is not JSON/);
  assert.match(parseStepCache("[]").problem ?? "", /not a JSON object/);
  const good = { seen: 1, unseen: 0, unread: 0, at: READ_AT };
  const read = parseStepCache(JSON.stringify({ job_a: good, job_b: { seen: -1, unseen: 0, unread: 0, at: READ_AT } }));
  assert.deepEqual(read.cache, { job_a: good });
  assert.match(read.problem ?? "", /1 entry of the wrong shape/);
});

test("the inbox drops a blocked job whose steps were all seen after it blocked, and only then", () => {
  const blocked = { id: "job_a", result_summary: "Add the secret.\ncheck: secret API_KEY on sample", updated_at: BLOCKED_AT };
  const seen = { seen: 1, unseen: 0, unread: 0, at: READ_AT };
  assert.equal(blockSettled(blocked, {}, null, { job_a: seen }), true);
  assert.equal(blockSettled(blocked, {}, null, { job_a: { ...seen, unseen: 1 } }), false, "one step not done");
  assert.equal(blockSettled(blocked, {}, null, { job_a: { ...seen, unread: 1 } }), false, "one step unread");
  assert.equal(blockSettled(blocked, {}, null, { job_a: { ...seen, at: "2026-10-10T09:00:00.000Z" } }), false, "read before the job last changed");
  assert.equal(blockSettled(blocked, {}, null, {}), false, "no read yet");
});

test("the stale view lists such a job as steps-seen, after prs-settled and before the other rules", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");
  const blocked = { status: "blocked", updated_at: BLOCKED_AT, auto_resumed_at: null };
  const seen = { seen: 2, unseen: 0, unread: 0, at: READ_AT };
  const row = classifyStale(blocked, undefined, now, seen);
  assert.equal(row?.rule, "steps-seen");
  assert.match(row?.reason ?? "", /every manual step it names is seen done \(2 steps, read 2026-10-10T11:00:00.000Z\)/);
  assert.equal(classifyStale(blocked, undefined, now, { ...seen, unseen: 1 })?.rule, "unchanged", "not every step seen: only its age counts");
  assert.equal(classifyStale(blocked, { merged: 1, closed: 0, open: 0, unread: 0, at: READ_AT }, now, seen)?.rule, "prs-settled");
  assert.equal(classifyStale({ ...blocked, status: "claimed" }, undefined, now, seen)?.rule, "unchanged", "only a blocked job");
});

test("the watcher's step reads every blocked job naming a step and rewrites the cache whole", async () => {
  const kv = fakeKv({ seed: { [STALE_STEPS_KEY]: JSON.stringify({ job_gone: { seen: 1, unseen: 0, unread: 0, at: READ_AT } }) } });
  const rows = [
    { id: "job_a", namespace: "sample", result_summary: "check: secret API_KEY on sample\ncheck: npm @example/kit@1.2.0", updated_at: BLOCKED_AT },
    { id: "job_b", namespace: "sample", result_summary: "check: access app Missing", updated_at: BLOCKED_AT },
    { id: "job_c", namespace: "sample", result_summary: "Mentions check: in prose only", updated_at: BLOCKED_AT },
    { id: "job_d", namespace: "sample", result_summary: Array.from({ length: 6 }, (_, i) => `check: npm kit@1.0.${i}`).join("\n"), updated_at: BLOCKED_AT },
  ];
  const sql: string[] = [];
  const db = {
    prepare: (q: string) => (sql.push(q), { bind: () => ({ all: async () => ({ results: rows }) }) }),
  };
  const report = await checkManualSteps(fakeEnv({ DB: db, APP_KV: kv.kv }), new Date(READ_AT), readers());
  assert.match(sql[0]!, /status = 'blocked' AND result_summary LIKE '%check:%'/);
  const cache = parseStepCache(kv.store.get(STALE_STEPS_KEY) ?? null).cache;
  assert.deepEqual(Object.keys(cache).sort(), ["job_a", "job_b", "job_d"], "a job no longer naming a step drops out");
  assert.deepEqual(cache.job_a, { seen: 2, unseen: 0, unread: 0, at: READ_AT });
  assert.deepEqual(cache.job_b, { seen: 0, unseen: 1, unread: 0, at: READ_AT });
  assert.deepEqual(cache.job_d, { seen: 0, unseen: 0, unread: 6, at: READ_AT }, "more than 5 steps are left unread");
  assert.deepEqual(report.seen, ["job_a"]);
  assert.equal(report.looked, 3);
});

test("the live readers fetch each name once per pass and read secrets from what the watcher stored", async () => {
  const kv = fakeKv({ seed: { "site-secrets:sample": JSON.stringify(secrets([{ name: "API_KEY", set: true }])) } });
  let npmCalls = 0;
  let accessCalls = 0;
  const live = liveStepReaders(fakeEnv({ APP_KV: kv.kv }), {
    npmVersions: async () => (npmCalls++, ["1.0.0"]),
    accessAppNames: async () => (accessCalls++, ["Sample Portal"]),
  });
  await Promise.all([live.npmVersions("kit"), live.npmVersions("kit"), live.accessAppNames(), live.accessAppNames()]);
  assert.equal(npmCalls, 1);
  assert.equal(accessCalls, 1);
  assert.equal(await stepState(parseStep("secret API_KEY on sample"), job, live), "seen");
  assert.equal(await stepState(parseStep("secret API_KEY on other"), job, live), "unread", "a namespace no pass stored");
});

test("npmVersions: the versions, null for a package npm does not have, and a throw for a failed read", async () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await npmVersions(answer(200, { versions: { "1.0.0": {}, "1.2.0": {} } }), "@example/kit"), ["1.0.0", "1.2.0"]);
  assert.equal(await npmVersions(answer(404, {}), "@example/kit"), null);
  await assert.rejects(npmVersions(answer(503, {}), "@example/kit"), /answered 503/);
});

test("readAccessAppNames copies the names only, and a 403 names the permission", async () => {
  let url = "";
  const ok = async (u: string) => {
    url = u;
    return new Response(JSON.stringify({ success: true, result: [{ name: "Sample Portal", saas_app: { client_secret: "x" } }, { id: "no-name" }], result_info: { total_pages: 1 } }));
  };
  assert.deepEqual(await readAccessAppNames(ok, "token", "acct"), ["Sample Portal"]);
  assert.match(url, /\/accounts\/acct\/access\/apps\?page=1&per_page=50$/);
  const refused = async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 });
  await assert.rejects(readAccessAppNames(refused, "token", "acct"), /lacks Account \/ Access: Apps and Policies \/ Read/);
});
