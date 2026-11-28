import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReposList, requireSinglePrimary, resolveRepo } from "../src/github/client.ts";
import { readRepoFile } from "../src/github/contents.ts";
import { managePr } from "../src/github/refs.ts";
import { ciStatus } from "../src/github/actions.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";
import { testPem } from "./test-pem.ts";
import { repoGuards } from "../src/tools/repo-guards.ts";

function makeEnv(
  repos: unknown[] | null,
  kv = fakeKv({ seedToken: true }),
  extra: Record<string, unknown> = {},
) {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => (repos === null ? null : { repos: JSON.stringify(repos) }),
        }),
        all: async () => ({ results: [{ namespace: "ns", repos: JSON.stringify(repos ?? []) }] }),
      }),
    },
    APP_KV: kv.kv,
    ...extra,
  });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const fileBody = (content: string, sha = "file-sha") => ({
  type: "file",
  encoding: "base64",
  content: b64(content),
  size: content.length,
  sha,
});

const TWO_REPOS = [
  { repo: "owner/primary-repo", label: "primary" },
  { repo: "owner/legacy-repo", label: "legacy" },
];

test("resolveRepo selects by label, by full owner/name, and defaults to the primary", async () => {
  for (const [selector, want] of [
    ["legacy", "owner/legacy-repo"],
    ["owner/legacy-repo", "owner/legacy-repo"],
    [undefined, "owner/primary-repo"],
  ] as const) {
    const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns", selector);
    assert.equal(ref.full, want, String(selector));
  }
});

test("resolveRepo refuses an unmapped selector, an unknown namespace, and a corrupt or empty mapping, each by name", async () => {
  const stored = (repos: string) =>
    fakeEnv({
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos }) }) }) },
      APP_KV: fakeKv().kv,
    });
  for (const [env, selector, pattern] of [
    [
      makeEnv(TWO_REPOS),
      "owner/somewhere-else",
      /not mapped to namespace ns.*owner\/primary-repo/s,
    ],
    [makeEnv(null), undefined, /unknown namespace: ns/],
    [stored("{not json"), undefined, /CORRUPT repos mapping/],
    [stored('{"repo":"o/r"}'), undefined, /CORRUPT repos mapping/],
    [stored("[]"), undefined, /has no repo mapping/],
  ] as const)
    await assert.rejects(() => resolveRepo(env, "ns", selector), pattern);
});

// Two namespaces, so a repo can be named from a namespace that does not map it.
function twoNamespaces() {
  const rows: Record<string, unknown[]> = {
    a: [{ repo: "Owner/a-repo", label: "primary" }],
    b: [
      { repo: "Owner/b-repo", label: "primary" },
      { repo: "Owner/tools", label: "tools" },
    ],
  };
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: (ns: string) => ({
          first: async () => (rows[ns] ? { repos: JSON.stringify(rows[ns]) } : null),
        }),
        all: async () => ({
          results: Object.entries(rows).map(([namespace, r]) => ({
            namespace,
            repos: JSON.stringify(r),
          })),
        }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

test("resolveRepo reaches a repo another namespace maps and names that namespace", async () => {
  for (const selector of ["owner/tools", "Owner/tools", "tools", "b-repo"]) {
    const ref = await resolveRepo(twoNamespaces(), "a", selector);
    assert.equal(ref.namespace, "b", selector);
  }
  await assert.rejects(
    () => resolveRepo(twoNamespaces(), "a", "owner/nowhere"),
    /not mapped to namespace a or to any other/,
  );
});

test("a repo named from another namespace is scope-checked against the namespace that maps it", async () => {
  const asked: Array<string | undefined> = [];
  const { guardedRead } = repoGuards({
    env: twoNamespaces(),
    scope: (need: { namespace?: string }) => {
      asked.push(need.namespace);
      return need.namespace === "a" ? null : "unauthorized: not scoped to b";
    },
  } as never);
  let ran = false;
  const result = (await guardedRead("read_repo_file", "a", "owner/tools", async () => {
    ran = true;
  })) as { isError?: boolean };
  assert.equal(result.isError, true);
  assert.equal(ran, false);
  assert.deepEqual(asked, ["b"]);
});

test("parseReposList defaults the label to primary, and rejects a non-array, an empty array, a bad owner/name and invalid JSON", () => {
  assert.deepEqual(parseReposList('[{"repo":"a/b"}]'), {
    list: [{ repo: "a/b", label: "primary" }],
  });
  for (const [input, message] of [
    ['{"repo":"a/b"}', /non-empty JSON array/],
    ["[]", /non-empty JSON array/],
    ['[{"repo":"not-a-repo"}]', /owner\/name/],
    ["{not json", /invalid repos JSON/],
  ] as const) {
    const result = parseReposList(input);
    assert.ok("error" in result && message.test(result.error), input);
  }
});

test("requireSinglePrimary demands exactly one primary", () => {
  assert.equal(requireSinglePrimary([{ repo: "a/b", label: "primary" }]), null);
  assert.ok(requireSinglePrimary([{ repo: "a/b", label: "legacy" }])?.includes("found 0"));
  assert.ok(
    requireSinglePrimary([
      { repo: "a/b", label: "primary" },
      { repo: "a/c", label: "primary" },
    ])?.includes("found 2"),
  );
});

// The routes a merge's branch cleanup reads: PR 5 merged `head` at h1, and the branch tip is `tip`.
const PR_ROUTES = (head: string, base = "main", tip = "h1") => ({
  "PUT /repos/o/r/pulls/5/merge": { body: { sha: "merged-sha", merged: true, message: "merged" } },
  "GET /repos/o/r/pulls/5": {
    body: { head: { ref: head, sha: "h1", repo: { full_name: "o/r" } }, base: { ref: base } },
  },
  "GET /repos/o/r": { body: { default_branch: base } },
  [`GET /repos/o/r/git/ref/heads/${head}`]: { body: { object: { sha: tip } } },
});

test("manage_pr merge calls the merge endpoint and returns the merged sha", async () => {
  await withFetch(
    {
      ...PR_ROUTES("feature/x"),
      "DELETE /repos/o/r/git/refs/heads/feature/x": { status: 204 },
    },
    async (calls) => {
      const result = await managePr(
        makeEnv([{ repo: "o/r", label: "primary" }]),
        "ns",
        5,
        "merge",
        "squash",
      );
      assert.deepEqual(result, {
        repo: "o/r",
        number: 5,
        action: "merge",
        merged: true,
        sha: "merged-sha",
        message: "merged",
        head_branch: "feature/x",
        head_branch_sha: "h1",
        head_branch_deleted: true,
      });
      assert.equal((calls[0].body as { merge_method: string }).merge_method, "squash");
    },
  );
});

test("PLANT: a merge keeps a head branch that gained a commit after the merged head", async () => {
  await withFetch(PR_ROUTES("feature/x", "main", "h2"), async (calls) => {
    const result = (await managePr(makeEnv(ONE_REPO), "ns", 5, "merge")) as {
      merged: boolean;
      head_branch_deleted: boolean;
      head_branch_note?: string;
    };
    assert.equal(result.merged, true);
    assert.equal(result.head_branch_deleted, false);
    assert.match(result.head_branch_note ?? "", /commits after the merged head h1/);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  });
});

const ONE_REPO = [{ repo: "o/r", label: "primary" }];
const READ_PREFIX = "gh:get:/repos/o/r/";

test("manage_pr merge invalidates that repo's cached reads, and no other repo's", async () => {
  const kv = fakeKv({ seedToken: true });
  const env = makeEnv(ONE_REPO, kv);
  // o/rr shares the owner and a prefix, so a sweep not scoped to o/r would take it too.
  kv.store.set("gh:get:/repos/o/r/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
  kv.store.set("gh:get:/repos/o/r/contents/?ref=main", JSON.stringify({ status: 200, body: "[]" }));
  kv.store.set("gh:get:/repos/o/rr/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "PUT /repos/o/r/pulls/5/merge": { body: { sha: "s", merged: true, message: "merged" } },
    },
    async () => {
      await managePr(env, "ns", 5, "merge");
      assert.deepEqual(kv.keysUnder(READ_PREFIX), []);
      assert.deepEqual(kv.keysUnder("gh:get:/repos/o/rr/"), ["gh:get:/repos/o/rr/contents/doc.md"]);
    },
  );
});

test("manage_pr close changes no content and leaves the cache alone", async () => {
  const kv = fakeKv({ seedToken: true });
  const env = makeEnv(ONE_REPO, kv);
  kv.store.set("gh:get:/repos/o/r/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
      "GET /repos/o/r": { body: { default_branch: "main" } },
    },
    async () => {
      await managePr(env, "ns", 5, "close");
      assert.deepEqual(kv.keysUnder(READ_PREFIX), ["gh:get:/repos/o/r/contents/doc.md"]);
    },
  );
});

test("reads of different refs are different cache entries", async () => {
  // The key carries the ref as a literal query, so a branch read cannot be served
  // from the default branch's entry. The invalidation design depends on it.
  const kv = fakeKv({ seedToken: true });
  const env = makeEnv(ONE_REPO, kv);
  await withFetch(
    {
      "GET /repos/o/r/contents/doc.md": (_b) => ({ body: fileBody("whatever") }),
    },
    async () => {
      await readRepoFile(env, "ns", "doc.md");
      await readRepoFile(env, "ns", "doc.md", "wip");
      assert.deepEqual(kv.keysUnder(READ_PREFIX).sort(), [
        "gh:get:/repos/o/r/contents/doc.md",
        "gh:get:/repos/o/r/contents/doc.md?ref=wip",
      ]);
    },
  );
});

test("the installation id is resolved per owner", async () => {
  const kv = fakeKv({ seedToken: false });
  const env = makeEnv(
    [
      { repo: "a/ra", label: "primary" },
      { repo: "b/rb", label: "second" },
    ],
    kv,
    {
      GITHUB_APP_CLIENT_ID: "Iv1.test",
      GITHUB_APP_PRIVATE_KEY: await testPem(),
    },
  );
  await withFetch(
    {
      "GET /repos/a/ra/installation": { body: { id: 111 } },
      "GET /repos/b/rb/installation": { body: { id: 222 } },
      "POST /app/installations/111/access_tokens": { body: { token: "token-for-111" } },
      "POST /app/installations/222/access_tokens": { body: { token: "token-for-222" } },
      "GET /repos/a/ra/contents/doc.md": { body: fileBody("a") },
      "GET /repos/b/rb/contents/doc.md": { body: fileBody("b") },
    },
    async (calls) => {
      await readRepoFile(env, "ns", "doc.md");
      await readRepoFile(env, "ns", "doc.md", undefined, "second");

      const minted = calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.path);
      assert.deepEqual(minted.sort(), [
        "/app/installations/111/access_tokens",
        "/app/installations/222/access_tokens",
      ]);
      assert.equal(kv.store.get("gh:install:v2:a"), "111");
      assert.equal(kv.store.get("gh:install:v2:b"), "222");
    },
  );
});

test("an installation token is minted for one repo and cached under owner/repo", async () => {
  // Two repos under ONE owner: a token keyed by owner alone would be reused for the second repo, and one minted without a repositories body would reach every repo.
  const kv = fakeKv({ seedToken: false });
  const env = makeEnv(
    [
      { repo: "a/ra", label: "primary" },
      { repo: "a/rb", label: "second" },
    ],
    kv,
    { GITHUB_APP_CLIENT_ID: "Iv1.test", GITHUB_APP_PRIVATE_KEY: await testPem() },
  );
  await withFetch(
    {
      "GET /repos/a/ra/installation": { body: { id: 111 } },
      "POST /app/installations/111/access_tokens": (body: unknown) => ({
        body: {
          token: `token-for-${(body as { repositories?: string[] }).repositories?.join(",")}`,
        },
      }),
      "GET /repos/a/ra/contents/doc.md": { body: fileBody("a") },
      "GET /repos/a/rb/contents/doc.md": { body: fileBody("b") },
    },
    async (calls) => {
      await readRepoFile(env, "ns", "doc.md");
      await readRepoFile(env, "ns", "doc.md", undefined, "second");
      const bodies = calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body);
      assert.deepEqual(
        bodies,
        [{ repositories: ["ra"] }, { repositories: ["rb"] }],
        "each token must be scoped to the one repo it is for",
      );
      assert.equal(kv.store.get("gh:token:v3:a/ra"), "token-for-ra");
      assert.equal(kv.store.get("gh:token:v3:a/rb"), "token-for-rb");
    },
  );
});

test("PLANT: every GitHub call, the App token mint included, carries a timeout signal", async () => {
  // With no signal a hung connection holds the request until the runtime kills it.
  const env = makeEnv(ONE_REPO, fakeKv({ seedToken: false }), {
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_PRIVATE_KEY: await testPem(),
  });
  const original = globalThis.fetch;
  const seen: Array<[string, unknown]> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push([path, init?.signal]);
    if (path.endsWith("/installation")) return Response.json({ id: 111 });
    if (path.endsWith("/access_tokens")) return Response.json({ token: "t" });
    return Response.json(fileBody("a"));
  }) as typeof fetch;
  try {
    await readRepoFile(env, "ns", "doc.md");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 3, JSON.stringify(seen.map(([p]) => p)));
  for (const [path, signal] of seen)
    assert.ok(signal instanceof AbortSignal, `${path} was fetched with no signal`);
});

test("a 404 on installation resolution says the credentials are fine", async () => {
  const env = makeEnv(ONE_REPO, fakeKv({ seedToken: false }), {
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_PRIVATE_KEY: await testPem(),
  });
  await withFetch(
    { "GET /repos/o/r/installation": { status: 404, body: { message: "Not Found" } } },
    async () => {
      await assert.rejects(() => readRepoFile(env, "ns", "doc.md"), /not installed on this repo/);
    },
  );
});

const FAILED_RUNS = {
  workflow_runs: [
    {
      id: 42,
      name: "CI",
      head_sha: "abcdef1234",
      status: "completed",
      conclusion: "failure",
      event: "push",
      created_at: "2026-08-17T00:00:00Z",
      html_url: "https://run",
    },
  ],
};
const JOBS_OK = {
  jobs: [
    {
      id: 9,
      name: "check",
      conclusion: "failure",
      steps: [{ name: "npm test", conclusion: "failure" }],
    },
  ],
};
type FailedRun = {
  jobs?: unknown;
  jobs_unavailable?: string;
  failing_job?: string;
  failing_step?: string | null;
  log?: string;
  log_region?: string;
  log_tail_unavailable?: string;
  log_tail_withheld?: string;
};

test("ci_status names an unavailable jobs fetch instead of dropping failed_run", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { status: 500, text: "upstream boom" },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.ok(failed, "failed_run was dropped entirely");
      assert.match(failed.jobs_unavailable ?? "", /^500: upstream boom/);
      assert.equal(failed.jobs, undefined);
    },
  );
});

test("ci_status names an unavailable log fetch for a write-grant caller", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
      "GET /repos/o/r/actions/jobs/9/logs": { status: 410, text: "log expired" },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_unavailable ?? "", /^410: log expired/);
      assert.equal(failed.log, undefined);
      // Not the read-only message: this caller was allowed the log and did not get one.
      assert.equal(failed.log_tail_withheld, undefined);
    },
  );
});

// The wiring, not just the function: `logTail: true` in the registration would give every read key the CI job logs.
test("capsid_inspect_repo action ci withholds the log tail from a read grant, without fetching it, and hands it to a write grant", async () => {
  for (const grant of ["read", "write"] as const)
    await withFetch(
      {
        "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
        "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
        "GET /repos/o/r/actions/jobs/9/logs": { text: "the last line" },
      },
      async (calls) => {
        const server = buildServer(makeEnv(ONE_REPO), grant, `test:${grant}`);
        const client = new Client({ name: "grant-test", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const result = (await client.callTool({
          name: "capsid_inspect_repo",
          arguments: { action: "ci", namespace: "ns" },
        })) as { structuredContent: { failed_run: FailedRun } };
        await client.close();
        const failed = result.structuredContent.failed_run;
        if (grant === "read") {
          assert.match(failed.log_tail_withheld ?? "", /read-only key/);
          assert.equal(failed.log, undefined);
          assert.equal(
            calls.some((c) => c.path.includes("/logs")),
            false,
            "a read-grant call fetched the job log",
          );
        } else {
          assert.match(failed.log ?? "", /the last line/);
          assert.equal(failed.log_tail_withheld, undefined);
        }
      },
    );
});

test("ci_status names the case where a failed run has no failed job", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": {
        body: { jobs: [{ id: 9, name: "check", conclusion: "cancelled" }] },
      },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_unavailable ?? "", /no job in it is/);
    },
  );
});

test("manage_pr close closes the PR and leaves its branch for the daily prune", async () => {
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
    },
    async (calls) => {
      const result = await managePr(makeEnv(ONE_REPO), "ns", 5, "close");
      assert.deepEqual(result, {
        repo: "o/r",
        number: 5,
        action: "close",
        state: "closed",
        url: "https://pr",
      });
      assert.equal((calls[0].body as { state: string }).state, "closed");
      assert.equal(calls.length, 1, "a close touched the branch");
    },
  );
});

test("a merge never deletes the default branch, a fork's branch or one it could not read, and says why", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["default branch", PR_ROUTES("main"), /same branch|default branch/],
    [
      "fork",
      {
        ...PR_ROUTES("patch-1"),
        "GET /repos/o/r/pulls/5": {
          body: {
            head: { ref: "patch-1", repo: { full_name: "someone/fork" } },
            base: { ref: "main" },
          },
        },
        "GET /repos/o/r": { body: { default_branch: "main" } },
      },
      /someone\/fork/,
    ],
    [
      "unreadable PR",
      { ...PR_ROUTES("feature/x"), "GET /repos/o/r/pulls/5": { status: 404, text: "Not Found" } },
      /could not read the PR/,
    ],
  ];
  for (const [name, routes, note] of cases) {
    await withFetch(routes as never, async (calls) => {
      const result = (await managePr(makeEnv(ONE_REPO), "ns", 5, "merge")) as {
        merged: boolean;
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.merged, true, name);
      assert.equal(result.head_branch_deleted, false, name);
      assert.match(result.head_branch_note ?? "", note, name);
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, name);
    });
  }
});

test("A FAILED BRANCH DELETE DOES NOT FAIL THE MERGE, because the merge already landed", async () => {
  await withFetch(
    {
      ...PR_ROUTES("feature/x"),
      "DELETE /repos/o/r/git/refs/heads/feature/x": {
        status: 403,
        text: "Resource not accessible by integration",
      },
    },
    async () => {
      const result = (await managePr(makeEnv(ONE_REPO), "ns", 5, "merge")) as {
        merged: boolean;
        sha: string;
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.merged, true, "a cleanup failure was reported as a failed merge");
      assert.equal(result.sha, "merged-sha");
      assert.equal(result.head_branch_deleted, false);
      assert.match(
        result.head_branch_note ?? "",
        /delete failed \(403\); the merge itself succeeded/,
      );
    },
  );
});
