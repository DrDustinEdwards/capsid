import assert from "node:assert/strict";
import { test } from "node:test";
import { SUSPENDED_KEY } from "../src/merge-units.ts";
import { PAUSED_KEY } from "../src/merge-safety.ts";
import {
  GOOD_POLICY,
  HEAD_SHA,
  MERGED_SHA,
  OWNER,
  enabledEnv,
  filesRoutes,
  isMerge,
  tickRoutes,
  tickWith,
  type Env,
} from "./auto-merge-fixtures.ts";

// The executor: an approved PR the policy leaves open merges on Dustin's approval. The
// approvals live in pr_approvals, which the fake D1 does not model, so they are answered
// here and each state move the executor batches is applied to them.

type ApprovalRow = {
  id: number;
  repo: string;
  pr: number;
  head_sha: string;
  class: string;
  status: string;
  approved_by: string;
  surface: string;
  batch_id: string | null;
  approved_at: string;
};

function withApprovals(env: Env, rows: ApprovalRow[], opts: { missingTable?: boolean } = {}) {
  const db = (env as unknown as { DB: D1Database }).DB;
  const moves: Array<{
    id: unknown;
    status: unknown;
    reason: unknown;
    merge_sha: unknown;
  }> = [];
  const own = (sql: string) => /pr_approvals/.test(sql);
  const stmt = (sql: string) => {
    if (opts.missingTable) throw new Error("D1_ERROR: no such table: pr_approvals");
    const s = {
      sql,
      params: [] as unknown[],
      bind(...p: unknown[]) {
        s.params = p;
        return s;
      },
      async all() {
        const results = /^\s*SELECT/i.test(sql)
          ? rows.filter((r) => r.status === "approved" && r.repo === s.params[0])
          : [];
        return { results, meta: {} };
      },
    };
    return s;
  };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => (own(sql) ? stmt(sql) : target.prepare(sql));
      if (prop === "batch") {
        return async (statements: Array<{ sql: string; params: unknown[] }>) => {
          const out: unknown[] = [];
          for (const s of statements) {
            if (!own(s.sql)) {
              out.push((await target.batch([s as never]))[0]);
              continue;
            }
            const row = rows.find((r) => r.id === s.params[0] && r.status === "approved");
            if (row) {
              row.status = String(s.params[1]);
              moves.push({
                id: row.id,
                status: s.params[1],
                reason: s.params[3],
                merge_sha: s.params[4],
              });
            }
            out.push({
              results: row ? [{ id: row.id }] : [],
              meta: { changes: row ? 1 : 0 },
            });
          }
          return out;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { env: { ...(env as object), DB: proxy } as typeof env, moves };
}

const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: 1,
  repo: "DrDustinEdwards/capsid",
  pr: 23,
  head_sha: HEAD_SHA,
  class: "approve",
  status: "approved",
  approved_by: "access:admin@example.com",
  surface: "portal",
  batch_id: null,
  approved_at: "2026-09-24T12:00:00.000Z",
  ...over,
});

// A src change: the capsid policy does not merge it, so only an approval can.
const SRC = ["src/merge-class.ts"];
const checkRuns = (status: string, conclusion: string | null) => ({
  [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: {
    body: { check_runs: [{ name: "test", status, conclusion }] },
  },
});

test("an approved PR the policy leaves open merges on the approval, pinned to the approved sha, and the row moves to merged", async () => {
  const { env, moves } = withApprovals((await enabledEnv()).env, [approval()]);
  const { outcome, calls } = await tickWith(env, tickRoutes(SRC));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.match(outcome.why ?? "", /merged on the approval of access:admin@example\.com \(portal\)/);
  assert.deepEqual(calls.find(isMerge)?.body, {
    merge_method: "merge",
    sha: HEAD_SHA,
  });
  assert.deepEqual(moves, [
    {
      id: 1,
      status: "merged",
      reason: `merged on the approval of access:admin@example.com (portal) at ${HEAD_SHA.slice(0, 7)}`,
      merge_sha: MERGED_SHA,
    },
  ]);
});

test("an approval is voided, expired, refused or left open, and nothing merges unattended", async () => {
  const moneyFile = tickRoutes(["src/billing/charge.ts"]);
  const failing409 = {
    ...tickRoutes(SRC),
    [`PUT ${OWNER}/pulls/23/merge`]: {
      status: 409,
      body: { message: "Head branch was modified." },
    },
  };
  const cases: Array<[string, Partial<ApprovalRow>, unknown, string | null, RegExp?]> = [
    [
      "a new push",
      { head_sha: "f".repeat(40) },
      tickRoutes(SRC),
      "voided",
      /^new push: approved at fffffff/,
    ],
    ["7 days old", { approved_at: "2026-09-18T11:00:00.000Z" }, tickRoutes(SRC), "expired"],
    [
      "red CI",
      {},
      { ...tickRoutes(SRC), ...checkRuns("completed", "failure") },
      "voided",
      /^CI red: /,
    ],
    ["CI still running", {}, { ...tickRoutes(SRC), ...checkRuns("in_progress", null) }, null],
    ["a 409 from GitHub", {}, failing409, "voided", /^head moved: /],
    ["a money path without typed confirmation", {}, moneyFile, "refused"],
  ];
  for (const [label, over, routes, status, reason] of cases) {
    const { env, moves } = withApprovals((await enabledEnv()).env, [approval(over)]);
    const { outcome, merges } = await tickWith(env, routes);
    assert.equal(outcome.merged, false, label);
    assert.equal(merges, label === "a 409 from GitHub" ? 1 : 0, label);
    assert.equal(moves[0]?.status ?? null, status, label);
    if (reason) assert.match(String(moves[0]?.reason), reason, label);
  }
});

test("with the approvals table missing the tick runs as the policy alone", async () => {
  const { env } = withApprovals((await enabledEnv()).env, [approval()], {
    missingTable: true,
  });
  const { outcome, merges } = await tickWith(env, tickRoutes(SRC));
  assert.equal(outcome.merged, false);
  assert.equal(merges, 0);
});

// Suspended merge units and paused namespaces only narrow: they hold back what the policy
// would merge, as class approve, and a list that cannot be read holds everything.

const SINCE = "2026-09-24T00:00:00Z";
const DOCS = ["docs/autonomy.md"];

test("a suspended unit holds back a PR the policy would merge; another unit's suspension does not; an unreadable list holds all", async () => {
  const suspend = async (value: string) => {
    const { env, kv } = await enabledEnv();
    await kv.kv.put(SUSPENDED_KEY, value);
    return tickWith(env, tickRoutes(DOCS));
  };
  const held = await suspend(
    JSON.stringify([{ unit: "capsid/docs", since: SINCE, reason: "rolled back" }]),
  );
  assert.equal(held.merges, 0);
  assert.equal(held.outcome.failed, "unit_suspended");
  assert.equal(held.outcome.merge_class?.class, "approve");
  assert.match(held.outcome.merge_class?.reasons[0] ?? "", /capsid\/docs is suspended/);

  const other = await suspend(
    JSON.stringify([{ unit: "capsid/dashboard-css", since: SINCE, reason: "x" }]),
  );
  assert.equal(other.outcome.merged, true, other.outcome.why ?? "");

  const unreadable = await suspend("not json");
  assert.equal(unreadable.merges, 0);
  assert.equal(unreadable.outcome.failed, "unit_suspended");
  assert.match(unreadable.outcome.why ?? "", /could not be read/);
});

test("a paused namespace holds back a PR the policy would merge; another namespace's pause does not; an unreadable list holds all", async () => {
  const pause = async (value: string) => {
    const { env, kv } = await enabledEnv();
    await kv.kv.put(PAUSED_KEY, value);
    return tickWith(env, tickRoutes(DOCS));
  };
  const reason = "2 of the pull requests auto-merge merged were rolled back or reverted in 7 days";
  const held = await pause(JSON.stringify({ capsid: { since: SINCE, reason } }));
  assert.equal(held.merges, 0);
  assert.equal(held.outcome.failed, "namespace_paused");
  assert.equal(held.outcome.merge_class?.class, "approve");
  assert.match(held.outcome.why ?? "", /^auto-merge for capsid is paused: 2 of the pull requests/);

  const other = await pause(JSON.stringify({ carrel: { since: SINCE, reason: "rolled back" } }));
  assert.equal(other.outcome.merged, true, other.outcome.why ?? "");

  const unreadable = await pause("not json");
  assert.equal(unreadable.merges, 0);
  assert.equal(unreadable.outcome.failed, "namespace_paused");
  assert.match(unreadable.outcome.why ?? "", /could not be read/);
});

test("an approval still merges a PR in a paused namespace", async () => {
  const { env, kv } = await enabledEnv();
  await kv.kv.put(PAUSED_KEY, JSON.stringify({ capsid: { since: SINCE, reason: "rolled back" } }));
  const a = withApprovals(env, [approval()]);
  const { outcome, merges } = await tickWith(a.env, tickRoutes(DOCS));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
  assert.equal(a.moves.length, 1);
});

// A unit the signed policy lists under ## Auto units widens its namespace's allowed paths, and only those.

const unitPolicy = (units: string[]) =>
  `${GOOD_POLICY}\n\n## Auto units\n\n${units.map((u) => `- unit \`${u}\``).join("\n")}\n`;

test("a promoted unit merges what the namespace's paths held back; another unit's promotion does not; a suspension still holds it", async () => {
  const unitTick = async (units: string[]) =>
    tickWith(
      (await enabledEnv({ policy: unitPolicy(units) })).env,
      tickRoutes(["test/jobs.test.ts"]),
    );
  const promoted = await unitTick(["capsid / tests"]);
  assert.equal(promoted.outcome.merged, true, promoted.outcome.why ?? "");
  assert.equal(promoted.merges, 1);
  const other = await unitTick(["capsid / dashboard-code"]);
  assert.equal(other.merges, 0);
  assert.equal(other.outcome.failed, "paths_allowed_for_namespace");

  const { env, kv } = await enabledEnv({
    policy: unitPolicy(["capsid / tests"]),
  });
  await kv.kv.put(
    SUSPENDED_KEY,
    JSON.stringify([{ unit: "capsid/tests", since: SINCE, reason: "x" }]),
  );
  const suspended = await tickWith(env, tickRoutes(["test/jobs.test.ts"]));
  assert.equal(suspended.merges, 0);
  assert.equal(suspended.outcome.failed, "unit_suspended");
});

// An existing test, changed, always waits for Dustin, even in a promoted unit.

const testFilesTick = async (
  files: Array<Record<string, unknown>>,
  approvals: ApprovalRow[] = [],
) => {
  const { env } = await enabledEnv({ policy: unitPolicy(["capsid / tests"]) });
  return tickWith(approvals.length ? withApprovals(env, approvals).env : env, filesRoutes(files));
};

test("a PR that only adds tests merges in a promoted tests unit; any change to an existing test is held as approve", async () => {
  const added = await testFilesTick([
    {
      filename: "test/new.test.ts",
      status: "added",
      additions: 40,
      deletions: 0,
    },
    {
      filename: "test/old.test.ts",
      status: "modified",
      additions: 6,
      deletions: 0,
    },
  ]);
  assert.equal(added.outcome.merged, true, added.outcome.why ?? "");
  assert.equal(added.outcome.merge_class?.class, "auto");

  const held: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "edited",
      {
        filename: "test/old.test.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
      /^changes an existing test: test\/old\.test\.ts/,
    ],
    [
      "deleted",
      {
        filename: "test/gone.test.ts",
        status: "removed",
        additions: 0,
        deletions: 30,
      },
      /test\/gone\.test\.ts/,
    ],
    [
      "renamed",
      {
        filename: "test/new-name.test.ts",
        previous_filename: "test/old-name.test.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      /test\/old-name\.test\.ts/,
    ],
    [
      "no status",
      { filename: "test/old.test.ts", additions: 3, deletions: 0 },
      /test\/old\.test\.ts/,
    ],
  ];
  for (const [label, file, reason] of held) {
    const { outcome, merges } = await testFilesTick([file]);
    assert.equal(merges, 0, label);
    assert.equal(outcome.failed, "changes_existing_test", label);
    assert.equal(outcome.merge_class?.class, "approve", label);
    assert.match(outcome.merge_class?.reasons[0] ?? "", reason, label);
  }
  const edit = {
    filename: "test/x.test.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
  };
  const approved = await testFilesTick([edit], [approval()]);
  assert.equal(approved.outcome.merged, true, approved.outcome.why ?? "");
});

// A pull request labeled visual waits for Dustin's look, and a draft is never sent to the merge API.

function visualRoutes(body: string) {
  const routes = tickRoutes(DOCS);
  const [pr] = routes[`GET ${OWNER}/pulls`].body;
  return {
    ...routes,
    [`GET ${OWNER}/pulls`]: {
      body: [{ ...pr, title: "New header", body, labels: [{ name: "visual" }] }],
    },
  };
}

test("a visual PR is held for Dustin's look with its preview and screenshots, and his approval merges it", async () => {
  const body =
    "Closes job_4c0ecc28548b.\n\nPreview: https://pr-23.sample.workers.dev/\n\n![after](https://example.com/after.png)";
  const held = await tickWith((await enabledEnv()).env, visualRoutes(body));
  assert.equal(held.merges, 0);
  assert.equal(held.outcome.failed, "visual_awaits_look");
  assert.equal(held.outcome.merge_class?.class, "approve");
  assert.deepEqual(held.outcome.visual, {
    title: "New header",
    preview: "https://pr-23.sample.workers.dev/",
    shots: ["https://example.com/after.png"],
  });

  const approved = withApprovals((await enabledEnv()).env, [approval()]);
  const merged = await tickWith(approved.env, visualRoutes("Closes job_4c0ecc28548b."));
  assert.equal(merged.outcome.merged, true, merged.outcome.why ?? "");
  assert.equal(merged.merges, 1);
});

test("a draft PR the policy would merge is held as class wait and never sent to the merge API", async () => {
  const routes = tickRoutes(DOCS);
  const [pr] = routes[`GET ${OWNER}/pulls`].body;
  const drafted = {
    ...routes,
    [`GET ${OWNER}/pulls`]: { body: [{ ...pr, draft: true }] },
  };
  const { outcome, merges } = await tickWith((await enabledEnv()).env, drafted);
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "pr_is_draft");
  assert.equal(outcome.merge_class?.class, "wait");
});
