import assert from "node:assert/strict";
import { test } from "node:test";
import { POLICY_CHECKS } from "../src/auto-merge-policy.ts";
import { FILES_LIMIT } from "../src/github/pr-files.ts";
import { AWAITING_SEAT_KEY, autoMergeTick } from "../src/auto-merge-tick.ts";
import { signTaskBody } from "../src/signed-docs.ts";
import { withFetch } from "./fakes.ts";
import {
  GOOD_POLICY,
  HEAD_SHA,
  OWNER,
  SECRET,
  enabledEnv,
  filesRoutes,
  isMerge,
  tickEnv,
  tickRoutes,
  tickWith,
} from "./auto-merge-fixtures.ts";

// the tick
//
// The checks above drive evaluatePolicy with hand-built facts. A tick that skipped
// loadMergePolicy, ignored `enabled: false`, or merged regardless of the verdict would
// leave them green, so the tick is driven against a signed document and fake GitHub routes.

const tickFiles = async (files: string[], opts?: Parameters<typeof enabledEnv>[0]) =>
  tickWith((await enabledEnv(opts)).env, tickRoutes(files));

test("a policy that is disabled, unsigned or absent makes the tick reach GitHub not once", async () => {
  const cases: Array<[string | null, RegExp]> = [
    [
      await signTaskBody(SECRET, GOOD_POLICY.replace("- enabled: true", "- enabled: false")),
      /disabled/,
    ],
    [GOOD_POLICY, /carries no capsid-task-signature/],
    [null, /no merge policy/],
  ];
  for (const [body, note] of cases) {
    const { env } = await tickEnv(body);
    await withFetch({}, async (calls) => {
      const report = await autoMergeTick(env, new Date("2026-09-13T12:00:00Z"));
      assert.equal(report.ran, false);
      assert.match(report.note, note);
      assert.equal(report.outcomes.length, 0);
      assert.equal(calls.length, 0, `GitHub was called: ${JSON.stringify(calls)}`);
    });
  }
});

test("the tick merges a green PR and declines a protected-path one without a merge call", async () => {
  const green = await tickFiles(["docs/schema.md", "dashboard/src/styles.css"]);
  assert.equal(green.outcome.merged, true, green.outcome.why ?? "");
  assert.equal(green.merges, 1);
  assert.deepEqual(green.outcome.passed, [...POLICY_CHECKS]);
  // Pinned to the judged head: a push between the reads and the merge gets a 409, not a merge.
  assert.deepEqual(green.calls.find(isMerge)?.body, { merge_method: "merge", sha: HEAD_SHA });

  const protectedPr = await tickFiles([".github/workflows/nightly.yml"]);
  assert.equal(protectedPr.outcome.merged, false);
  assert.ok(protectedPr.outcome.failed);
  assert.equal(protectedPr.merges, 0);
});

test("a rename is judged under both names", async () => {
  const toDocs = [
    {
      filename: "docs/limits.md",
      previous_filename: "src/limits.ts",
      status: "renamed",
    },
  ];
  const outOfSrc = await tickWith((await enabledEnv()).env, filesRoutes(toDocs));
  assert.equal(outOfSrc.merges, 0);
  assert.equal(outOfSrc.outcome.failed, "paths_allowed_for_namespace");
  assert.match(outOfSrc.outcome.why ?? "", /src\/limits\.ts/);

  const outOfRefused = [
    { filename: "src/limits.ts" },
    {
      filename: "src/old-merge.ts",
      previous_filename: "src/auto-merge.ts",
      status: "renamed",
    },
  ];
  const refused = await tickWith((await enabledEnv()).env, filesRoutes(outOfRefused));
  assert.equal(refused.merges, 0);
  assert.equal(refused.outcome.failed, "paths_not_refused");
  assert.match(refused.outcome.why ?? "", /src\/auto-merge\.ts/);
});

test("a PR whose files GitHub reports without line counts is declined, not counted as zero", async () => {
  const { outcome, merges } = await tickWith(
    (await enabledEnv()).env,
    filesRoutes([{ filename: "docs/autonomy.md" }]),
  );
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "size_within_cap");
  assert.match(outcome.why ?? "", /no line counts/);
});

test("a fork PR is refused by the tick", async () => {
  const { outcome, merges } = await tickWith(
    (await enabledEnv()).env,
    tickRoutes(["docs/schema.md"], "attacker/capsid"),
  );
  assert.equal(merges, 0);
  assert.equal(outcome.failed, "head_in_base_repo");
});

test("the tick refuses when the Actions run list cannot be read", async () => {
  const routes = {
    ...tickRoutes(["docs/schema.md"]),
    [`GET ${OWNER}/actions/runs`]: {
      status: 403,
      text: "Resource not accessible by integration",
    },
  };
  const { outcome, merges } = await tickWith((await enabledEnv()).env, routes);
  assert.equal(outcome.failed, "ci_green");
  assert.match(outcome.why ?? "", /403/);
  assert.equal(merges, 0);
});

// The merge is pinned to the head the policy judged: without `sha`, a push between the
// reads and the merge would be merged unjudged, and GitHub answers 409 when it moved.

const auditActions = (d1: { recorded: Array<{ sql: string; params: unknown[] }> }) =>
  d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql)).map((r) => r.params[1]);

test("a head that moved before the merge (GitHub 409) is not merged, audited, and does not abort the tick", async () => {
  const { d1, kv, env } = await enabledEnv();
  const routes = {
    ...tickRoutes(["docs/schema.md"]),
    [`PUT ${OWNER}/pulls/23/merge`]: {
      status: 409,
      body: { message: "Head branch was modified." },
    },
  };
  const { outcome } = await tickWith(env, routes);
  assert.equal(outcome.merged, false);
  assert.equal(outcome.failed, "head_moved");
  assert.match(outcome.why ?? "", new RegExp(HEAD_SHA));
  const audits = d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params[1], "auto-merge-declined");
  assert.equal(JSON.parse(String(audits[0].params[4])).head_sha, HEAD_SHA);
  const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string);
  assert.deepEqual(
    awaiting.map((a: { failed: string }) => a.failed),
    ["head_moved"],
  );
});

test("the awaiting-seat set carries each PR's merge class, why and the judged head sha", async () => {
  for (const [paths, cls, pathClass] of [
    [["src/inbox.ts"], "approve", "src-routine"],
    [["migrations/0099_sample.sql"], "seat", "migration"],
    [["docs/schema.md", "src/billing/plan.ts"], "typed", "money"],
  ] as const) {
    const { kv, env } = await enabledEnv();
    const { outcome } = await tickWith(env, tickRoutes([...paths]));
    assert.equal(outcome.merged, false, paths.join());
    const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string);
    assert.equal(awaiting.length, 1);
    assert.equal(awaiting[0].class, cls, paths.join());
    assert.equal(awaiting[0].path_class, pathClass);
    assert.ok(awaiting[0].class_reasons.length > 0, "a class with no reason");
    // The Portal's Approve sends this sha.
    assert.equal(awaiting[0].head_sha, HEAD_SHA);
  }
});

// paging: every page of files and check runs is read

function paged<T>(rows: T[], wrap: (page: T[]) => unknown = (page) => page) {
  return (_body: unknown, search: URLSearchParams) => {
    const perPage = Number(search.get("per_page") ?? 30);
    const page = Number(search.get("page") ?? 1);
    const more = page * perPage < rows.length;
    return {
      body: wrap(rows.slice((page - 1) * perPage, page * perPage)),
      ...(more
        ? {
            headers: {
              Link: `<https://api.github.com/repositories/1/x?per_page=${perPage}&page=${page + 1}>; rel="next"`,
            },
          }
        : {}),
    };
  };
}

function pagedRoutes(
  files: string[],
  runs: Array<{ name: string; status: string; conclusion: string | null }>,
) {
  return {
    ...tickRoutes([]),
    [`GET ${OWNER}/pulls/23/files`]: paged(
      files.map((filename) => ({ filename, additions: 1, deletions: 0 })),
    ),
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: paged(runs, (page) => ({
      total_count: runs.length,
      check_runs: page,
    })),
  };
}

const safeFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => `docs/page-${String(i).padStart(4, "0")}.md`);
const green = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `check-${i}`,
    status: "completed",
    conclusion: "success",
  }));
const tickPaged = async (routes: unknown) => tickWith((await enabledEnv()).env, routes);

test("a protected path or a failing check on the second page is seen, and the PR is not merged", async () => {
  const file = await tickPaged(
    pagedRoutes([...safeFiles(100), "migrations/0099_planted.sql"], green(1)),
  );
  assert.equal(file.merges, 0);
  assert.equal(file.outcome.failed, "paths_not_refused");
  assert.match(file.outcome.why ?? "", /migrations\/0099_planted\.sql/);

  const late = {
    name: "late-check",
    status: "completed",
    conclusion: "failure",
  };
  const run = await tickPaged(pagedRoutes(safeFiles(2), [...green(100), late]));
  assert.equal(run.merges, 0);
  assert.equal(run.outcome.failed, "ci_green");
  assert.match(run.outcome.why ?? "", /late-check=failure/);
});

test("paging is not a refusal: a green PR spread over several pages still merges", async () => {
  const { outcome, merges } = await tickPaged(pagedRoutes(safeFiles(250), green(150)));
  assert.equal(outcome.merged, true, outcome.why ?? "");
  assert.equal(merges, 1);
});

test("a file list GitHub truncates, or a page that fails partway, is refused, not judged on what loaded", async () => {
  // GitHub stops offering a next page at 3000 files, so a list at the ceiling cannot be told from a cut one.
  const truncated = await tickPaged(pagedRoutes(safeFiles(FILES_LIMIT), green(1)));
  assert.equal(truncated.merges, 0);
  assert.match(truncated.outcome.why ?? "", new RegExp(`at most ${FILES_LIMIT} files`));

  const files = paged(
    safeFiles(150).map((filename) => ({
      filename,
      additions: 1,
      deletions: 0,
    })),
  );
  const routes = {
    ...pagedRoutes([], green(1)),
    [`GET ${OWNER}/pulls/23/files`]: (body: unknown, search: URLSearchParams) =>
      search.get("page") === "2" ? { status: 502, text: "bad gateway" } : files(body, search),
  };
  const partial = await tickPaged(routes);
  assert.equal(partial.merges, 0);
  assert.match(partial.outcome.why ?? "", /502/);
});

// one PR cannot end the tick

const SECOND_SHA = "cccc000000000000000000000000000000000000";
const NEW_SHA = "c0ffee00123456789012345678901234567890cd";

function twoPrRoutes(mergeRoute: unknown, secondSha = SECOND_SHA) {
  const base = tickRoutes(["docs/schema.md"]);
  return {
    ...base,
    [`GET ${OWNER}/pulls`]: {
      body: [
        ...(base[`GET ${OWNER}/pulls`] as { body: unknown[] }).body,
        {
          number: 30,
          body: "A second change.",
          head: {
            sha: secondSha,
            repo: { full_name: "DrDustinEdwards/capsid" },
          },
          base: { ref: "master" },
          user: { login: "DrDustinEdwards" },
        },
      ],
    },
    [`GET ${OWNER}/pulls/30/files`]: base[`GET ${OWNER}/pulls/23/files`],
    [`GET ${OWNER}/commits/${secondSha}/check-runs`]:
      base[`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`],
    [`PUT ${OWNER}/pulls/23/merge`]: mergeRoute,
  };
}

test("a merge GitHub refuses with 405 is audited as failed, and the tick goes on to the next PR", async () => {
  const { d1, kv, env } = await enabledEnv();
  const { report } = await tickWith(
    env,
    twoPrRoutes({
      status: 405,
      body: { message: "Pull Request is not mergeable" },
    }),
  );
  assert.equal(report.outcomes.length, 2, "the throw on PR 23 stopped the tick before PR 30");
  const first = report.outcomes.find((o) => o.number === 23);
  assert.equal(first?.merged, false);
  assert.equal(first?.failed, "error");
  assert.match(first?.why ?? "", /405/);
  assert.ok(auditActions(d1).includes("auto-merge-failed"));
  const awaiting = JSON.parse((await kv.kv.get(AWAITING_SEAT_KEY)) as string) as Array<{
    number: number;
    failed: string;
  }>;
  assert.deepEqual(awaiting.map((a) => [a.number, a.failed]).sort(), [
    [23, "error"],
    [30, "ci_green"],
  ]);
});

// A decline is logged when the decision changes: the tick runs every five minutes, and a
// PR refused for the same reason on the same head leaves one audit row, not one per tick.

const PROTECTED = [".github/workflows/nightly.yml"];

function declineRows(d1: { recorded: Array<{ sql: string; params: unknown[] }> }) {
  return d1.recorded
    .filter((r) => /INSERT INTO audit_log/.test(r.sql) && r.params[1] === "auto-merge-declined")
    .map((r) => JSON.parse(String(r.params[4])) as { head_sha: string; failed: string });
}

// The same PR with its head moved to NEW_SHA: the PR list and the per-sha reads follow it.
function movedHeadRoutes(files: string[]) {
  const routes = tickRoutes(files);
  const [pr] = routes[`GET ${OWNER}/pulls`].body;
  return {
    ...routes,
    [`GET ${OWNER}/pulls`]: {
      body: [{ ...pr, head: { ...pr.head, sha: NEW_SHA } }],
    },
    [`GET ${OWNER}/commits/${NEW_SHA}/check-runs`]:
      routes[`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`],
  };
}

test("a repeated decline writes one row; a different reason or a new head writes another", async () => {
  const { d1, env } = await enabledEnv();
  await tickWith(env, tickRoutes(PROTECTED), 0);
  await tickWith(env, tickRoutes(PROTECTED), 5);
  assert.equal(declineRows(d1).length, 1, "a repeated decision was logged again");

  await tickWith(env, tickRoutes(["docs/schema.md"], "DrDustinEdwards/capsid", "someone-else"), 10);
  const reasons = declineRows(d1);
  assert.equal(reasons.length, 2);
  assert.notEqual(reasons[0].failed, reasons[1].failed);

  await tickWith(env, movedHeadRoutes(PROTECTED), 15);
  assert.deepEqual(
    declineRows(d1).map((r) => r.head_sha),
    [HEAD_SHA, HEAD_SHA, NEW_SHA],
  );
});

test("a KV read that fails still logs the decline", async () => {
  const { d1, kv, env } = await enabledEnv();
  const realGet = kv.kv.get.bind(kv.kv);
  (kv.kv as { get: unknown }).get = async (key: string, ...rest: unknown[]) => {
    if (key.startsWith("improve:auto-merge-last-decline:")) throw new Error("kv down");
    return (realGet as (k: string, ...r: unknown[]) => unknown)(key, ...rest);
  };
  await tickWith(env, tickRoutes(PROTECTED), 0);
  assert.equal(declineRows(d1).length, 1, "a KV outage lost the decline row");
});
