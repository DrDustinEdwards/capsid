import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteBranch,
  encodePath,
  parseReposList,
  readRepoFile,
  repoTokenOk,
} from "../src/github.ts";
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

test("repoPathProblem rejects '.' and '..' segments and control chars, and allows real repo paths", () => {
  assert.ok(repoPathProblem("../../x"));
  assert.ok(repoPathProblem("a/../b"));
  assert.ok(repoPathProblem("./x"));
  assert.ok(repoPathProblem("a/b/.."));
  assert.ok(repoPathProblem("x/\n/y"));
  assert.ok(repoPathProblem("/leading"));
  assert.ok(repoPathProblem("trailing/"));
  assert.ok(repoPathProblem("a//b"));
  assert.equal(repoPathProblem(".github/workflows/improve-score.yml"), null);
  assert.equal(repoPathProblem(".npmrc"), null);
  assert.equal(repoPathProblem("src/foo.test.ts"), null);
  assert.equal(repoPathProblem("a..b/c"), null); // "a..b" is a legal name; only a whole ".." segment moves the URL
  assert.equal(repoPathProblem("README.md"), null);
});

test("encodePath throws on a '..' segment (old code returned it verbatim)", () => {
  assert.throws(() => encodePath("../../x"), /'\.\.' segment/);
  assert.throws(() => encodePath("a/./b"), /'\.' segment/);
  assert.equal(encodePath("a/b c/d.md"), "a/b%20c/d.md");
});

test("repoTokenOk and parseReposList reject '..' as an owner/name mapping", () => {
  assert.equal(repoTokenOk("../evil"), false);
  assert.equal(repoTokenOk("owner/.."), false);
  assert.equal(repoTokenOk("owner/repo"), true);
  const bad = parseReposList(JSON.stringify([{ repo: "../evil", label: "primary" }]));
  assert.ok("error" in bad);
  const good = parseReposList(JSON.stringify([{ repo: "owner/repo", label: "primary" }]));
  assert.ok("list" in good);
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
