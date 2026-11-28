import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePath, parseReposList, repoTokenOk } from "../src/github/client.ts";
import { readRepoFile } from "../src/github/contents.ts";
import { deleteBranch } from "../src/github/refs.ts";
import { repoPathProblem } from "../src/limits.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// A path or branch with "../.." escapes /repos/<owner>/<repo>/ once fetch() parses it as a URL, which a fake
// keyed on the raw string cannot see, so the tests read the recorded call's normalized pathname.

function makeEnv(repos: unknown[]) {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => ({ repos: JSON.stringify(repos) }) }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const ONE_REPO = [{ repo: "owner/mapped-repo", label: "primary" }];

test("the path, segment and owner/name validators refuse '.' and '..' segments, and allow real names", () => {
  for (const bad of [
    "../../x",
    "a/../b",
    "./x",
    "a/b/..",
    "x/\n/y",
    "/leading",
    "trailing/",
    "a//b",
  ])
    assert.ok(repoPathProblem(bad), bad);
  // "a..b" is a legal name; only a whole ".." segment moves the URL.
  for (const good of [
    ".github/workflows/ci.yml",
    ".npmrc",
    "src/foo.test.ts",
    "a..b/c",
    "README.md",
  ])
    assert.equal(repoPathProblem(good), null, good);
  assert.throws(() => encodePath("../../x"), /'\.\.' segment/);
  assert.throws(() => encodePath("a/./b"), /'\.' segment/);
  assert.equal(encodePath("a/b c/d.md"), "a/b%20c/d.md");
  assert.equal(repoTokenOk("../evil"), false);
  assert.equal(repoTokenOk("owner/.."), false);
  assert.equal(repoTokenOk("owner/repo"), true);
  assert.ok("error" in parseReposList(JSON.stringify([{ repo: "../evil", label: "primary" }])));
});

test("read_repo_file refuses a traversal path and makes no escaping request", async () => {
  await withFetch(
    {
      "GET /repos/owner/other-repo/contents/secrets.env": {
        body: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("SECRET").toString("base64"),
          size: 6,
          sha: "x",
        },
      },
    },
    async (calls) => {
      await assert.rejects(
        () => readRepoFile(makeEnv(ONE_REPO), "ns", "../../other-repo/contents/secrets.env"),
        /path segment|escapes \/repos/,
      );
      for (const c of calls) {
        assert.ok(
          c.path.startsWith("/repos/owner/mapped-repo/") ||
            c.path.startsWith("/app/") ||
            c.path === "/repos/owner/mapped-repo",
          `unexpected escaping request to ${c.path}`,
        );
      }
    },
  );
});

test("delete_branch refuses a traversal branch and makes no escaping request", async () => {
  await withFetch({}, async (calls) => {
    await assert.rejects(
      () => deleteBranch(makeEnv(ONE_REPO), "ns", "../../tags/v1"),
      /path segment|escapes \/repos/,
    );
    for (const c of calls) {
      assert.ok(!c.path.includes("/tags/"), `unexpected escaping request to ${c.path}`);
    }
  });
});
