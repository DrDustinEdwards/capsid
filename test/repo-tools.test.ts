import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ciStatus,
  createBranch,
  deleteRepoFile,
  managePr,
  parseReposList,
  readRepoFile,
  requireSinglePrimary,
  resolveRepo,
  writeRepoFile,
} from "../src/github.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// KV, Env and the HTTP stub come from ./fakes.ts.

function makeEnv(repos: unknown[] | null, kv = fakeKv({ seedToken: true }), extra: Record<string, unknown> = {}) {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => (repos === null ? null : { repos: JSON.stringify(repos) }) }),
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

// repo selector resolution

const TWO_REPOS = [
  { repo: "owner/primary-repo", label: "primary" },
  { repo: "owner/legacy-repo", label: "legacy" },
];

test("resolveRepo selects by label", async () => {
  const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns", "legacy");
  assert.equal(ref.full, "owner/legacy-repo");
});

test("resolveRepo selects by full owner/name", async () => {
  const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns", "owner/legacy-repo");
  assert.equal(ref.full, "owner/legacy-repo");
});

test("resolveRepo defaults to the primary when no selector is given", async () => {
  const ref = await resolveRepo(makeEnv(TWO_REPOS), "ns");
  assert.equal(ref.full, "owner/primary-repo");
});

test("resolveRepo rejects an unmapped selector with the valid values", async () => {
  await assert.rejects(
    () => resolveRepo(makeEnv(TWO_REPOS), "ns", "owner/somewhere-else"),
    /not mapped to namespace ns.*owner\/primary-repo/s
  );
});

test("resolveRepo rejects an unknown namespace", async () => {
  await assert.rejects(() => resolveRepo(makeEnv(null), "ghost"), /unknown namespace: ghost/);
});

// namespace repos validation

test("parseReposList accepts a valid array and defaults the label to primary", () => {
  const result = parseReposList('[{"repo":"a/b"}]');
  assert.deepEqual(result, { list: [{ repo: "a/b", label: "primary" }] });
});

test("parseReposList rejects a non-array", () => {
  const result = parseReposList('{"repo":"a/b"}');
  assert.ok("error" in result && /non-empty JSON array/.test(result.error));
});

test("parseReposList rejects an empty array", () => {
  const result = parseReposList("[]");
  assert.ok("error" in result && /non-empty JSON array/.test(result.error));
});

test("parseReposList rejects a malformed owner/name", () => {
  const result = parseReposList('[{"repo":"not-a-repo"}]');
  assert.ok("error" in result && /owner\/name/.test(result.error));
});

test("parseReposList rejects invalid JSON", () => {
  const result = parseReposList("{not json");
  assert.ok("error" in result && /invalid repos JSON/.test(result.error));
});

test("requireSinglePrimary demands exactly one primary", () => {
  assert.equal(requireSinglePrimary([{ repo: "a/b", label: "primary" }]), null);
  assert.ok(requireSinglePrimary([{ repo: "a/b", label: "legacy" }])?.includes("found 0"));
  assert.ok(
    requireSinglePrimary([
      { repo: "a/b", label: "primary" },
      { repo: "a/c", label: "primary" },
    ])?.includes("found 2")
  );
});

// delete_repo_file: mode + precondition

test("delete_repo_file direct mode deletes on the default branch", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/contents/doc.md": { body: { sha: "file-sha" } },
      "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "commit-sha" } } },
    },
    async (calls) => {
      const result = await deleteRepoFile(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", "doc.md", "remove it", "direct");
      assert.deepEqual(result, {
        repo: "o/r",
        mode: "direct",
        branch: "main",
        path: "doc.md",
        commitSha: "commit-sha",
      });
      const del = calls.find((c) => c.method === "DELETE");
      assert.equal((del?.body as { sha: string }).sha, "file-sha");
      assert.equal((del?.body as { branch: string }).branch, "main");
    }
  );
});

test("delete_repo_file errors clearly when the file does not exist", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/contents/gone.md": { status: 404, body: { message: "Not Found" } },
    },
    async () => {
      await assert.rejects(
        () => deleteRepoFile(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", "gone.md", "msg", "direct"),
        /does not exist on o\/r@main/
      );
    }
  );
});

test("delete_repo_file pr mode opens a branch and a PR", async () => {
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
      "POST /repos/o/r/git/refs": { status: 201, body: {} },
      "GET /repos/o/r/contents/doc.md": { body: { sha: "file-sha" } },
      "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "commit-sha" } } },
      "POST /repos/o/r/pulls": { status: 201, body: { number: 7, html_url: "https://pr" } },
    },
    async () => {
      const result = (await deleteRepoFile(
        makeEnv([{ repo: "o/r", label: "primary" }]),
        "ns",
        "doc.md",
        "remove it",
        "pr"
      )) as { mode: string; branch: string; pr: { number: number } };
      assert.equal(result.mode, "pr");
      assert.ok(result.branch.startsWith("capsid/rm-"));
      assert.equal(result.pr.number, 7);
    }
  );
});

// pr mode never commits to the default branch. can_direct_write guards mode "direct"
// only, so a pr-mode call naming the default branch as its work branch must be refused.
// The repo here is an ordinary mapped repo, not the server's own.
const ONE_REPO_PR = [{ repo: "o/r", label: "primary" }];
const PR_MODE_ROUTES = {
  "GET /repos/o/r": { body: { default_branch: "main" } },
  "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
  "POST /repos/o/r/git/refs": { status: 201, body: {} },
  "GET /repos/o/r/contents/doc.md": { body: { sha: "file-sha" } },
  "PUT /repos/o/r/contents/doc.md": { body: { commit: { sha: "commit-sha" }, content: { sha: "new-file-sha" } } },
  "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "commit-sha" } } },
  "POST /repos/o/r/pulls": { status: 201, body: { number: 9, html_url: "https://pr" } },
  "GET /repos/o/r/pulls": { body: [] },
};

for (const verb of ["write", "delete"] as const) {
  test(`${verb}_repo_file pr mode with branch set to the default branch is refused before anything is written`, async () => {
    await withFetch(PR_MODE_ROUTES, async (calls) => {
      const env = makeEnv(ONE_REPO_PR);
      await assert.rejects(
        () =>
          verb === "write"
            ? writeRepoFile(env, "ns", "doc.md", "NEW", "m", "pr", "main")
            : deleteRepoFile(env, "ns", "doc.md", "m", "pr", "main"),
        /refuses: mode "pr" with branch main, which is the default branch of o\/r/
      );
      assert.deepEqual(
        calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`),
        [],
        "no branch, commit or pull request request may reach GitHub"
      );
    });
  });
}

test("write_repo_file pr mode with a named work branch still commits there and opens a PR", async () => {
  await withFetch(PR_MODE_ROUTES, async (calls) => {
    const result = (await writeRepoFile(makeEnv(ONE_REPO_PR), "ns", "doc.md", "NEW", "m", "pr", "feature/x")) as {
      branch: string;
      pr: { number: number };
    };
    assert.equal(result.branch, "feature/x");
    assert.equal(result.pr.number, 9);
    const put = calls.find((c) => c.method === "PUT");
    assert.equal((put?.body as { branch: string }).branch, "feature/x");
    const pull = calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"));
    assert.deepEqual(
      { head: (pull?.body as { head: string }).head, base: (pull?.body as { base: string }).base },
      { head: "feature/x", base: "main" }
    );
    // The open-PR lookup ran for the named branch and found nothing.
    const lookup = calls.find((c) => c.method === "GET" && c.path === "/repos/o/r/pulls");
    const params = new URLSearchParams(lookup?.search ?? "");
    assert.deepEqual({ head: params.get("head"), state: params.get("state") }, { head: "o:feature/x", state: "open" });
  });
});

// A pr-mode call naming a branch that already has an open pull request would commit
// onto a PR the caller may not own. It is refused unless the call names that PR's
// number with `pr`, and a call that names it commits without opening a second PR.
const OPEN_PR_ROUTES = {
  ...PR_MODE_ROUTES,
  "GET /repos/o/r/pulls": (_body: unknown, params: URLSearchParams) =>
    params.get("head") === "o:feature/x" && params.get("state") === "open"
      ? { body: [{ number: 41, html_url: "https://github.com/o/r/pull/41" }] }
      : { body: [] },
};

const nonGet = (calls: Array<{ method: string; path: string }>) =>
  calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);

for (const verb of ["write", "delete"] as const) {
  const run = (env: ReturnType<typeof makeEnv>, branch: string, pr?: number) =>
    verb === "write"
      ? writeRepoFile(env, "ns", "doc.md", "NEW", "m", "pr", branch, undefined, undefined, pr)
      : deleteRepoFile(env, "ns", "doc.md", "m", "pr", branch, undefined, undefined, pr);

  test(`${verb}_repo_file pr mode on a branch with an open PR is refused without pr, before any commit`, async () => {
    await withFetch(OPEN_PR_ROUTES, async (calls) => {
      await assert.rejects(
        () => run(makeEnv(ONE_REPO_PR), "feature/x"),
        /refuses: branch feature\/x on o\/r already has open pull request #41 \(https:\/\/github\.com\/o\/r\/pull\/41\).*pr: 41/
      );
      assert.deepEqual(nonGet(calls), [], "no branch, commit or pull request request may reach GitHub");
    });
  });

  test(`${verb}_repo_file pr mode naming the branch's open PR commits there and opens no second PR`, async () => {
    await withFetch(OPEN_PR_ROUTES, async (calls) => {
      const result = (await run(makeEnv(ONE_REPO_PR), "feature/x", 41)) as {
        branch: string;
        commitSha: string;
        pr: { number: number; url: string; existing?: boolean };
      };
      assert.equal(result.branch, "feature/x");
      assert.equal(result.commitSha, "commit-sha");
      assert.deepEqual(result.pr, { number: 41, url: "https://github.com/o/r/pull/41", existing: true });
      assert.deepEqual(
        nonGet(calls).filter((c) => c.endsWith("/pulls")),
        [],
        "a call that names an existing PR must not open another"
      );
      const mutation = calls.find((c) => c.method === (verb === "write" ? "PUT" : "DELETE"));
      assert.equal((mutation?.body as { branch: string }).branch, "feature/x");
    });
  });

  test(`${verb}_repo_file pr mode naming a PR that is not the branch's open PR is refused`, async () => {
    await withFetch(OPEN_PR_ROUTES, async (calls) => {
      await assert.rejects(() => run(makeEnv(ONE_REPO_PR), "feature/x", 40), /refuses: pr 40 .*open pull request #41/);
      // A branch with no open PR at all: the named number cannot be its PR either.
      await assert.rejects(() => run(makeEnv(ONE_REPO_PR), "feature/y", 40), /refuses: pr 40 .*feature\/y has no open pull request/);
      assert.deepEqual(nonGet(calls), [], "no branch, commit or pull request request may reach GitHub");
    });
  });
}

test("write_repo_file pr mode refuses when the open-PR lookup fails, rather than treating it as none", async () => {
  await withFetch({ ...PR_MODE_ROUTES, "GET /repos/o/r/pulls": { status: 502, text: "bad gateway" } }, async (calls) => {
    await assert.rejects(
      () => writeRepoFile(makeEnv(ONE_REPO_PR), "ns", "doc.md", "NEW", "m", "pr", "feature/x"),
      /refuses: could not check open pull requests for feature\/x on o\/r \(502\)/
    );
    assert.deepEqual(nonGet(calls), []);
  });
});

test("write_repo_file refuses pr in direct mode, where there is no pull request to name", async () => {
  await withFetch(PR_MODE_ROUTES, async (calls) => {
    await assert.rejects(
      () => writeRepoFile(makeEnv(ONE_REPO_PR), "ns", "doc.md", "NEW", "m", "direct", "feature/x", undefined, undefined, 41),
      /refuses: pr names an existing pull request/
    );
    assert.deepEqual(calls, []);
  });
});

// manage_pr: action routing

// The routes manage_pr needs for its branch cleanup, factored out because every
// case below wants them. PR_ROUTES(head) names the head branch of PR 5.
const PR_ROUTES = (head: string, base = "main") => ({
  "GET /repos/o/r/pulls/5": { body: { head: { ref: head, repo: { full_name: "o/r" } }, base: { ref: base } } },
  "GET /repos/o/r": { body: { default_branch: base } },
});

test("manage_pr merge calls the merge endpoint and returns the merged sha", async () => {
  await withFetch(
    {
      "PUT /repos/o/r/pulls/5/merge": { body: { sha: "merged-sha", merged: true, message: "merged" } },
      ...PR_ROUTES("feature/x"),
      "DELETE /repos/o/r/git/refs/heads/feature/x": { status: 204 },
    },
    async (calls) => {
      const result = await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "merge", "squash");
      assert.deepEqual(result, {
        repo: "o/r",
        number: 5,
        action: "merge",
        merged: true,
        sha: "merged-sha",
        message: "merged",
        head_branch: "feature/x",
        head_branch_deleted: true,
      });
      assert.equal((calls[0].body as { merge_method: string }).merge_method, "squash");
    }
  );
});

// read cache invalidation

const ONE_REPO = [{ repo: "o/r", label: "primary" }];
const READ_PREFIX = "gh:get:/repos/o/r/";

test("a read after a write returns the new content, not the cached body", async () => {
  // Read (caches), write, read again inside the 60 second TTL. The second read must
  // not serve the body the write replaced.
  const kv = fakeKv({ seedToken: true });
  const env = makeEnv(ONE_REPO, kv);
  let content = "OLD";
  await withFetch(
    {
      "GET /repos/o/r": { body: { default_branch: "main" } },
      "GET /repos/o/r/contents/doc.md": () => ({ body: fileBody(content) }),
      "PUT /repos/o/r/contents/doc.md": (requestBody) => {
        content = Buffer.from((requestBody as { content: string }).content, "base64").toString("utf8");
        return { body: { commit: { sha: "commit-sha" }, content: { sha: "new-file-sha" } } };
      },
    },
    async () => {
      const first = await readRepoFile(env, "ns", "doc.md");
      assert.equal(first.content, "OLD");
      assert.ok(kv.keysUnder(READ_PREFIX).length > 0, "the read did not cache, so this test proves nothing");

      await writeRepoFile(env, "ns", "doc.md", "NEW", "msg", "direct");

      const second = await readRepoFile(env, "ns", "doc.md");
      assert.equal(second.content, "NEW");
    }
  );
});

test("every mutating path invalidates that repo's cached reads", async () => {
  // One case per mutating call site that changes what a read would return.
  const cases: Array<{ name: string; run: (env: never) => Promise<unknown> }> = [
    { name: "write_repo_file direct", run: (env) => writeRepoFile(env, "ns", "doc.md", "NEW", "m", "direct") },
    { name: "write_repo_file pr", run: (env) => writeRepoFile(env, "ns", "doc.md", "NEW", "m", "pr") },
    { name: "delete_repo_file direct", run: (env) => deleteRepoFile(env, "ns", "doc.md", "m", "direct") },
    { name: "delete_repo_file pr", run: (env) => deleteRepoFile(env, "ns", "doc.md", "m", "pr") },
    { name: "manage_pr merge", run: (env) => managePr(env, "ns", 5, "merge") },
  ];
  for (const c of cases) {
    const kv = fakeKv({ seedToken: true });
    const env = makeEnv(ONE_REPO, kv);
    // Two cached reads of this repo, plus one of a DIFFERENT repo under the same
    // owner: the sweep must be scoped to o/r and must not take o/rr with it.
    kv.store.set("gh:get:/repos/o/r/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
    kv.store.set("gh:get:/repos/o/r/contents/?ref=main", JSON.stringify({ status: 200, body: "[]" }));
    kv.store.set("gh:get:/repos/o/rr/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
    await withFetch(
      {
        "GET /repos/o/r": { body: { default_branch: "main" } },
        "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
        "POST /repos/o/r/git/refs": { status: 201, body: {} },
        "GET /repos/o/r/contents/doc.md": { body: fileBody("OLD") },
        "PUT /repos/o/r/contents/doc.md": { body: { commit: { sha: "c" }, content: { sha: "f" } } },
        "DELETE /repos/o/r/contents/doc.md": { body: { commit: { sha: "c" } } },
        "POST /repos/o/r/pulls": { status: 201, body: { number: 7, html_url: "https://pr" } },
        "PUT /repos/o/r/pulls/5/merge": { body: { sha: "s", merged: true, message: "merged" } },
      },
      async () => {
        await c.run(env);
        assert.deepEqual(kv.keysUnder(READ_PREFIX), [], `${c.name} left a stale cache entry`);
        assert.deepEqual(
          kv.keysUnder("gh:get:/repos/o/rr/"),
          ["gh:get:/repos/o/rr/contents/doc.md"],
          `${c.name} swept a different repo's cache`
        );
      }
    );
  }
});

test("a call that changes no content leaves the cache alone", async () => {
  // The innocent case: a sweep that fires on everything would pass the tests above.
  for (const c of [
    { name: "manage_pr close", run: (env: never) => managePr(env, "ns", 5, "close") },
    { name: "create_branch", run: (env: never) => createBranch(env, "ns", "wip") },
  ]) {
    const kv = fakeKv({ seedToken: true });
    const env = makeEnv(ONE_REPO, kv);
    kv.store.set("gh:get:/repos/o/r/contents/doc.md", JSON.stringify({ status: 200, body: "{}" }));
    await withFetch(
      {
        "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
        "GET /repos/o/r": { body: { default_branch: "main" } },
        "GET /repos/o/r/git/ref/heads/main": { body: { object: { sha: "head-sha" } } },
        "POST /repos/o/r/git/refs": { status: 201, body: {} },
      },
      async () => {
        await c.run(env);
        assert.deepEqual(kv.keysUnder(READ_PREFIX), ["gh:get:/repos/o/r/contents/doc.md"], `${c.name} swept the cache`);
      }
    );
  }
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
    }
  );
});

// per-owner installation resolution

// A real key, so createAppJwt and importPrivateKey run rather than being stubbed
// around. Generated once for the file.
let pemPromise: Promise<string> | null = null;
function testPem(): Promise<string> {
  pemPromise ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let binary = "";
    for (const byte of der) binary += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  })();
  return pemPromise;
}

test("the installation id is resolved per owner, and a pinned id is not consulted", async () => {
  // Two owners in one namespace mapping, one KV, one env carrying the retired
  // GITHUB_APP_INSTALLATION_ID. One id cannot be right for both owners.
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
      GITHUB_APP_INSTALLATION_ID: "999",
    }
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
      assert.equal(
        minted.some((p) => p.includes("/999/")),
        false,
        "the retired pinned installation id was used to mint a token"
      );
      assert.equal(kv.store.get("gh:install:v2:a"), "111");
      assert.equal(kv.store.get("gh:install:v2:b"), "222");
    }
  );
});

test("an installation token is minted for one repo and cached under owner/repo", async () => {
  // Two repos under ONE owner. A token keyed by owner alone would be minted once and
  // reused for the second repo, and a token minted without a repositories body would
  // reach every repo in the installation.
  const kv = fakeKv({ seedToken: false });
  const env = makeEnv(
    [
      { repo: "a/ra", label: "primary" },
      { repo: "a/rb", label: "second" },
    ],
    kv,
    { GITHUB_APP_CLIENT_ID: "Iv1.test", GITHUB_APP_PRIVATE_KEY: await testPem() }
  );
  await withFetch(
    {
      "GET /repos/a/ra/installation": { body: { id: 111 } },
      "POST /app/installations/111/access_tokens": (body: unknown) => ({
        body: { token: `token-for-${(body as { repositories?: string[] }).repositories?.join(",")}` },
      }),
      "GET /repos/a/ra/contents/doc.md": { body: fileBody("a") },
      "GET /repos/a/rb/contents/doc.md": { body: fileBody("b") },
    },
    async (calls) => {
      await readRepoFile(env, "ns", "doc.md");
      await readRepoFile(env, "ns", "doc.md", undefined, "second");
      const bodies = calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body);
      assert.deepEqual(bodies, [{ repositories: ["ra"] }, { repositories: ["rb"] }], "each token must be scoped to the one repo it is for");
      assert.equal(kv.store.get("gh:token:v3:a/ra"), "token-for-ra");
      assert.equal(kv.store.get("gh:token:v3:a/rb"), "token-for-rb");
    }
  );
});

test("a 404 on installation resolution says the credentials are fine", async () => {
  const env = makeEnv(ONE_REPO, fakeKv({ seedToken: false }), {
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_PRIVATE_KEY: await testPem(),
  });
  await withFetch({ "GET /repos/o/r/installation": { status: 404, body: { message: "Not Found" } } }, async () => {
    await assert.rejects(() => readRepoFile(env, "ns", "doc.md"), /not installed on this repo/);
  });
});

// ci_status degraded shapes

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
  jobs: [{ id: 9, name: "check", conclusion: "failure", steps: [{ name: "npm test", conclusion: "failure" }] }],
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
    }
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
    }
  );
});

test("ci_status still withholds the log tail from a read-only key", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
    },
    async (calls) => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: false });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_withheld ?? "", /read-only key/);
      assert.equal(failed.log, undefined);
      assert.equal(failed.log_tail_unavailable, undefined);
      // And the log was never fetched, so it cannot leak by another route.
      assert.equal(calls.some((c) => c.path.includes("/logs")), false);
    }
  );
});

// The timestamp window is tested in test/repo-fallthrough.test.ts.

// The wiring, not just the function. The tests above call ciStatus directly, so they
// pass whatever the tool hands it; `logTail: true` in the registration would give every
// read key the CI job logs. This drives the tool through a server built with a read
// grant.
test("a read-grant server does not hand the CI log tail to ci_status", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
      "GET /repos/o/r/actions/jobs/9/logs": { text: "a secret from the build log" },
    },
    async (calls) => {
      const server = buildServer(makeEnv(ONE_REPO), "read", "test:ro");
      const client = new Client({ name: "grant-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = (await client.callTool({
        name: "ci_status",
        arguments: { namespace: "ns" },
      })) as { content: Array<{ text: string }> };
      await client.close();
      const failed = (JSON.parse(result.content[0].text) as { failed_run: FailedRun }).failed_run;
      assert.match(failed.log_tail_withheld ?? "", /read-only key/);
      assert.equal(failed.log, undefined);
      // The log was never requested, so it cannot leak by any other route.
      assert.equal(calls.some((c) => c.path.includes("/logs")), false, "a read-grant call fetched the job log");
    }
  );
});

test("a write-grant server does hand the log tail through, so the gate is a gate", async () => {
  // A wiring that withheld from everyone would pass the test above.
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
      "GET /repos/o/r/actions/jobs/9/logs": { text: "the last line" },
    },
    async () => {
      const server = buildServer(makeEnv(ONE_REPO), "write", "test:rw");
      const client = new Client({ name: "grant-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = (await client.callTool({
        name: "ci_status",
        arguments: { namespace: "ns" },
      })) as { content: Array<{ text: string }> };
      await client.close();
      const failed = (JSON.parse(result.content[0].text) as { failed_run: FailedRun }).failed_run;
      assert.match(failed.log ?? "", /the last line/);
      assert.equal(failed.log_tail_withheld, undefined);
    }
  );
});

test("ci_status returns the failing step's log when it can", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: JOBS_OK },
      "GET /repos/o/r/actions/jobs/9/logs": { text: "the last line" },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.equal(failed.log, "the last line");
      assert.equal(failed.log_tail_unavailable, undefined);
      // The step name is reported, and because this fixture's log does not contain
      // it, log_region says so rather than claiming the region is the step's.
      assert.equal(failed.failing_step, "npm test");
      assert.match(failed.log_region ?? "", /no usable timestamp window/);
    }
  );
});

test("ci_status names the case where a failed run has no failed job", async () => {
  await withFetch(
    {
      "GET /repos/o/r/actions/runs": { body: FAILED_RUNS },
      "GET /repos/o/r/actions/runs/42/jobs": { body: { jobs: [{ id: 9, name: "check", conclusion: "cancelled" }] } },
    },
    async () => {
      const result = await ciStatus(makeEnv(ONE_REPO), "ns", undefined, { logTail: true });
      const failed = result.failed_run as FailedRun;
      assert.match(failed.log_tail_unavailable ?? "", /no job in it is/);
    }
  );
});

test("manage_pr close patches the PR state to closed, and deletes the head branch", async () => {
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
      ...PR_ROUTES("capsid/content-projects-json-mtkyt0ds"),
      "DELETE /repos/o/r/git/refs/heads/capsid/content-projects-json-mtkyt0ds": { status: 204 },
    },
    async (calls) => {
      const result = await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "close");
      assert.deepEqual(result, {
        repo: "o/r",
        number: 5,
        action: "close",
        state: "closed",
        url: "https://pr",
        head_branch: "capsid/content-projects-json-mtkyt0ds",
        head_branch_deleted: true,
      });
      assert.equal((calls[0].body as { state: string }).state, "closed");
      assert.ok(
        calls.some((c) => c.method === "DELETE" && c.path.includes("capsid/content-projects-json")),
        "the Capsid PR-mode branch was not cleaned up"
      );
    }
  );
});

// the branch cleanup's three refusals, and the property that it never fails

test("manage_pr NEVER deletes the default branch, whatever the PR says", async () => {
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
      ...PR_ROUTES("main"),
    },
    async (calls) => {
      const result = (await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "close")) as {
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.head_branch_deleted, false);
      // head === base is caught first, which is also correct; either note is a refusal.
      assert.match(result.head_branch_note ?? "", /same branch|default branch/);
      assert.equal(calls.some((c) => c.method === "DELETE"), false, "it issued a DELETE against the default branch");
    }
  );
});

test("manage_pr LEAVES an improve-loop branch alone, because the loop owns those refs", async () => {
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
      ...PR_ROUTES("improve/capsid-2026-09-06-a01"),
    },
    async (calls) => {
      const result = (await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "close")) as {
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.head_branch_deleted, false, "it deleted an attempt branch the loop may still need");
      assert.match(result.head_branch_note ?? "", /improve/);
      assert.equal(calls.some((c) => c.method === "DELETE"), false);
    }
  );
});

test("manage_pr leaves a FORK's head branch alone", async () => {
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
      "GET /repos/o/r/pulls/5": { body: { head: { ref: "patch-1", repo: { full_name: "someone/fork" } }, base: { ref: "main" } } },
      "GET /repos/o/r": { body: { default_branch: "main" } },
    },
    async (calls) => {
      const result = (await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "close")) as {
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.head_branch_deleted, false);
      assert.match(result.head_branch_note ?? "", /someone\/fork/);
      assert.equal(calls.some((c) => c.method === "DELETE"), false);
    }
  );
});

test("A FAILED BRANCH DELETE DOES NOT FAIL THE MERGE, because the merge already landed", async () => {
  // Reporting the whole call as failed because a cleanup step failed would misreport the
  // merge.
  await withFetch(
    {
      "PUT /repos/o/r/pulls/5/merge": { body: { sha: "merged-sha", merged: true, message: "merged" } },
      ...PR_ROUTES("feature/x"),
      "DELETE /repos/o/r/git/refs/heads/feature/x": { status: 403, text: "Resource not accessible by integration" },
    },
    async () => {
      const result = (await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "merge")) as {
        merged: boolean;
        sha: string;
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.merged, true, "a cleanup failure was reported as a failed merge");
      assert.equal(result.sha, "merged-sha");
      assert.equal(result.head_branch_deleted, false);
      assert.match(result.head_branch_note ?? "", /403/);
      assert.match(result.head_branch_note ?? "", /PR action itself succeeded/);
    }
  );
});

test("an unreadable PR leaves the branch alone and says why, without failing the close", async () => {
  await withFetch(
    {
      "PATCH /repos/o/r/pulls/5": { body: { number: 5, state: "closed", html_url: "https://pr" } },
      "GET /repos/o/r/pulls/5": { status: 404, text: "Not Found" },
    },
    async (calls) => {
      const result = (await managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "close")) as {
        state: string;
        head_branch: string | null;
        head_branch_deleted: boolean;
        head_branch_note?: string;
      };
      assert.equal(result.state, "closed", "the close was reported as failed");
      assert.equal(result.head_branch, null);
      assert.equal(result.head_branch_deleted, false);
      assert.match(result.head_branch_note ?? "", /could not read the PR/);
      assert.equal(calls.some((c) => c.method === "DELETE"), false);
    }
  );
});

// a corrupt repos row fails closed

test("resolveRepo names a corrupt repos mapping instead of reporting none", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: "{not json" }) }) }) },
    APP_KV: fakeKv().kv,
  } as never;
  await assert.rejects(() => resolveRepo(env, "ns"), /CORRUPT repos mapping/);
});

test("resolveRepo refuses a repos value that parses but is not an array", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: '{"repo":"o/r"}' }) }) }) },
    APP_KV: fakeKv().kv,
  } as never;
  await assert.rejects(() => resolveRepo(env, "ns"), /CORRUPT repos mapping/);
});

test("an empty mapping still reports as unconfigured, not as corrupt", async () => {
  // The two states must stay distinguishable in both directions.
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repos: "[]" }) }) }) },
    APP_KV: fakeKv().kv,
  } as never;
  await assert.rejects(() => resolveRepo(env, "ns"), /has no repo mapping/);
});

// comment must never reach the branch cleanup. Without the early return in
// src/github/refs.ts a comment falls through to the close branch: it PATCHes the pull
// request shut and deletes the head branch. The scope tests cannot see that, because
// the registrar allows manage_pr.comment. Close and delete are wired to throw, so a
// fallthrough fails loudly.

test("PLANT: manage_pr comment POSTs a comment and touches neither the PR state nor the branch", async () => {
  await withFetch(
    {
      "POST /repos/o/r/issues/5/comments": { body: { id: 99, html_url: "https://pr#issuecomment-99" } },
    },
    async (calls) => {
      const result = (await managePr(
        makeEnv([{ repo: "o/r", label: "primary" }]),
        "ns",
        5,
        "comment",
        "squash",
        undefined,
        "REVIEW: looks right. APPROVE"
      )) as { action: string; comment_id: number; head_branch_deleted?: boolean };

      assert.equal(result.action, "comment");
      assert.equal(result.comment_id, 99);
      // A comment ENDS no pull request, so the cleanup must not have run at all.
      assert.equal(result.head_branch_deleted, undefined, "a comment reported a branch cleanup");

      const posted = calls.filter((c) => c.method === "POST" && c.path === "/repos/o/r/issues/5/comments");
      assert.equal(posted.length, 1, "the comment was not posted");
      assert.equal((posted[0].body as { body: string }).body, "REVIEW: looks right. APPROVE");

      // The two calls that must not happen, asserted by method so the failure names the
      // defect: a comment that fell through to close would PATCH, then DELETE the head ref.
      assert.equal(calls.some((c) => c.method === "PATCH"), false, "a comment closed the pull request");
      assert.equal(calls.some((c) => c.method === "DELETE"), false, "a comment deleted the head branch");
      assert.equal(calls.length, 1, `a comment made ${calls.length} GitHub calls: ${JSON.stringify(calls.map((c) => c.method + " " + c.path))}`);
    }
  );
});

test("manage_pr comment with nothing to say is refused before any GitHub call", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => managePr(makeEnv([{ repo: "o/r", label: "primary" }]), "ns", 5, "comment"),
      /comment needs a body/
    );
    assert.equal(calls.length, 0, "an empty comment still reached GitHub");
  });
});
