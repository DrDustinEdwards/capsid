import assert from "node:assert/strict";
import { policyDocument } from "./policy-doc.ts";
import { AUTO_MERGE_POLICY_PATH, AUTO_MERGE_REQUIRED_CI } from "../src/auto-merge-policy.ts";
import { autoMergeTick } from "../src/auto-merge-tick.ts";
import { signTaskBody } from "../src/signed-docs.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

export const SECRET = "test-improve-secret";
export const CAPSID_CI = AUTO_MERGE_REQUIRED_CI.capsid;
// The author allowlist lives only in the signed document; evaluatePolicy gets it from the loaded policy.
export const ALLOWED_AUTHORS = ["DrDustinEdwards", "capsid-repo-access[bot]"];
export const success = <T extends object>(rows: T[]) =>
  rows.map((r) => ({ ...r, conclusion: "success" }));

export const GOOD_POLICY = policyDocument(1, { authors: ALLOWED_AUTHORS });

const NS_ROW = [
  {
    namespace: "capsid",
    repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]),
  },
];
export const OWNER = "/repos/DrDustinEdwards/capsid";
export const HEAD_SHA = "bfae8ca9012345678901234567890123456789ab";
export const PR_URL = "https://github.com/DrDustinEdwards/capsid/pull/23";
export const MERGED_SHA = "merged00000000000000000000000000000000000";

export async function tickEnv(policyBody: string | null, over: Record<string, unknown> = {}) {
  const d1 = fakeD1({
    namespaces: NS_ROW,
    documents:
      policyBody === null
        ? []
        : [
            {
              namespace: "capsid",
              path: AUTO_MERGE_POLICY_PATH,
              title: "policy",
              body: policyBody,
            },
          ],
    ...over,
  });
  const kv = fakeKv({ seedToken: true });
  return {
    d1,
    kv,
    env: fakeEnv({ DB: d1.db, APP_KV: kv.kv, IMPROVE_SCORE_SECRET: SECRET }),
  };
}

export async function enabledEnv(opts: { policy?: string } = {}) {
  return tickEnv(await signTaskBody(SECRET, opts.policy ?? GOOD_POLICY), {
    agents: [{ name: "capsid-driver", kind: "driver", revoked_at: null }],
  });
}
export type Env = Awaited<ReturnType<typeof tickEnv>>["env"];

function ciRunRoutes() {
  return {
    [`GET ${OWNER}/actions/runs`]: (_body: unknown, search: URLSearchParams) => ({
      body: {
        workflow_runs:
          search.get("head_sha") === HEAD_SHA
            ? [
                { id: 900, path: ".github/workflows/ci.yml" },
                { id: 950, path: ".github/workflows/ci.yml" },
                { id: 990, path: ".github/workflows/improve-score.yml" },
              ]
            : [],
      },
    }),
    // The older CI run and the unrelated workflow's run exercise the newest-run and path filters.
    [`GET ${OWNER}/actions/runs/900/jobs`]: { body: { jobs: [] } },
    [`GET ${OWNER}/actions/runs/950/jobs`]: {
      body: {
        jobs: [
          {
            name: "checks",
            steps: [
              { name: "Install dependencies", conclusion: "success" },
              ...CAPSID_CI.map((r) => ({
                name: r.step,
                conclusion: "success",
              })),
            ],
          },
          {
            name: "deploy",
            steps: [{ name: "Deploy", conclusion: "skipped" }],
          },
        ],
      },
    },
  };
}

export function tickRoutes(
  changedFiles: string[],
  headRepo: string | null = "DrDustinEdwards/capsid",
  author: string | null = "DrDustinEdwards",
) {
  return {
    [`GET ${OWNER}`]: { body: { default_branch: "master" } },
    [`GET ${OWNER}/pulls`]: {
      body: [
        {
          number: 23,
          body: "Closes job_4c0ecc28548b.",
          head: {
            sha: HEAD_SHA,
            repo: headRepo === null ? null : { full_name: headRepo },
          },
          base: { ref: "master" },
          user: author === null ? null : { login: author },
        },
      ],
    },
    [`GET ${OWNER}/pulls/23/files`]: {
      body: changedFiles.map((filename) => ({
        filename,
        status: "modified",
        additions: 1,
        deletions: 0,
      })),
    },
    [`GET ${OWNER}/commits/${HEAD_SHA}/check-runs`]: {
      body: {
        check_runs: [{ name: "test", status: "completed", conclusion: "success" }],
      },
    },
    [`PUT ${OWNER}/pulls/23/merge`]: { body: { sha: MERGED_SHA } },
    ...ciRunRoutes(),
  };
}

// The same routes with PR 23's files answered by `body` (renames, statuses, line counts).
export const filesRoutes = (body: unknown) => ({
  ...tickRoutes([]),
  [`GET ${OWNER}/pulls/23/files`]: { body },
});

export const isMerge = (c: { method: string; path: string }) =>
  c.method === "PUT" && c.path.endsWith("/merge");

export async function tickWith(env: Env, routes: unknown, minute = 0) {
  let report!: Awaited<ReturnType<typeof autoMergeTick>>;
  let merges = 0;
  let calls: Array<{
    method: string;
    path: string;
    search?: string;
    body?: unknown;
  }> = [];
  await withFetch(routes as never, async (c) => {
    report = await autoMergeTick(env, new Date(Date.UTC(2026, 8, 25, 12, minute)));
    calls = c as typeof calls;
    merges = calls.filter(isMerge).length;
  });
  assert.equal(report.ran, true, report.note);
  return { report, outcome: report.outcomes[0], merges, calls };
}
