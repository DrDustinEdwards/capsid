import assert from "node:assert/strict";
import { test } from "node:test";
import { searchAllRepos, searchCode } from "../src/github/search.ts";
import { toolOutput } from "../src/tools/outputs.ts";
import { fakeEnv, fakeKv, withFetch, type FetchCall, type Route } from "./fakes.ts";

// search_code greps every blob, one request each, so it most often runs out of quota mid-scan. A skipped blob must not
// become total_results 0: "not found" and "could not check" are different answers.

function makeEnv() {
  return fakeEnv({
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]),
          }),
        }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
}

const TREE_PATH = "/repos/owner/repo/git/trees/main";
const REPO_PATH = "/repos/owner/repo";

function tree(paths: string[]) {
  return {
    truncated: false,
    tree: paths.map((p, i) => ({ path: p, type: "blob", sha: `sha${i}`, size: 100 })),
  };
}

function blob(text: string) {
  return { encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") };
}

// blobsOf proves a cap: files_scanned is the tool's own account, and a cap reporting 1 while fetching 3 still burns three requests.
const blobsOf = (calls: FetchCall[], paths: string[]) =>
  calls
    .filter((c) => c.path.includes("/git/blobs/sha"))
    .map((c) => paths[Number(c.path.split("/git/blobs/sha")[1])]);

async function withTree(
  opts: { paths: string[]; contents: Record<string, string>; blobStatus?: Record<string, number> },
  fn: (calls: FetchCall[]) => Promise<void>,
) {
  const routes: Record<string, Route> = {
    [`GET ${REPO_PATH}`]: { body: { default_branch: "main" } },
    [`GET ${TREE_PATH}`]: { body: tree(opts.paths) },
  };
  opts.paths.forEach((path, i) => {
    const status = opts.blobStatus?.[path];
    routes[`GET ${REPO_PATH}/git/blobs/sha${i}`] = status
      ? { status, body: { message: "boom" } }
      : { body: blob(opts.contents[path] ?? "") };
  });
  await withFetch(routes, fn);
}

test("rate-limited blob fetch ABORTS the scan instead of returning empty", async () => {
  await withTree(
    {
      paths: ["a.ts", "b.ts"],
      contents: { "a.ts": "const EMAIL_QUEUE = 1;", "b.ts": "x" },
      blobStatus: { "a.ts": 403, "b.ts": 403 },
    },
    async () => {
      await assert.rejects(
        () => searchCode(makeEnv(), "ns", "EMAIL_QUEUE"),
        (err: Error) => {
          assert.match(err.message, /aborted/i, "must say the scan aborted");
          assert.match(
            err.message,
            /NOT an empty result/i,
            "must refuse to be read as a negative finding",
          );
          assert.match(err.message, /403/, "must name the status");
          return true;
        },
      );
    },
  );
});

test("429 and 401 abort too: a revoked token is not an empty repository", async () => {
  for (const status of [429, 401]) {
    await withTree(
      { paths: ["a.ts"], contents: { "a.ts": "x" }, blobStatus: { "a.ts": status } },
      async () => {
        await assert.rejects(
          () => searchCode(makeEnv(), "ns", "anything"),
          /aborted/i,
          `${status}`,
        );
      },
    );
  }
});

test("a survivable per-file error does NOT abort, but is reported", async () => {
  // A 404 on one blob (a raced deletion) is per-file, so the scan continues, but "0 results over 2 files" and "... 1 unreadable" are different claims.
  await withTree(
    {
      paths: ["gone.ts", "here.ts"],
      contents: { "here.ts": "const EMAIL_QUEUE = 1;" },
      blobStatus: { "gone.ts": 404 },
    },
    async () => {
      const r = (await searchCode(makeEnv(), "ns", "EMAIL_QUEUE")) as {
        total_results: number;
        unreadable_files?: number;
        unreadable_sample?: string[];
      };
      assert.equal(r.total_results, 1, "the readable file still matches");
      assert.equal(r.unreadable_files, 1, "the unreadable file is counted");
      assert.deepEqual(r.unreadable_sample, ["gone.ts"], "and named");
    },
  );
});

// max_files bounds one call's cost against the installation's hourly quota; an off-by-one shows up as quota exhaustion for later calls.

const THREE = ["a.ts", "b.ts", "c.ts"];
const CONTENTS = { "a.ts": "needle here", "b.ts": "needle again", "c.ts": "needle third" };

test("max_files 1 stops after ONE blob and reports where to resume", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxFiles: 1 });
    // The cap is proven by the request that was not made.
    assert.deepEqual(
      blobsOf(calls, THREE),
      ["a.ts"],
      "the cap did not stop the scan: it fetched more than one blob",
    );
    assert.equal(result.candidates, 3);
    assert.equal(result.files_scanned, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.next_start, 1, "next_start must name the first UNSEARCHED file");
    assert.match(result.note ?? "", /max_files cap \(1\)/);
    assert.match(result.note ?? "", /2 of 3 candidate files were not searched/);
  });
});

test("resuming at next_start scans the next file and nothing before it", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxFiles: 1, start: 1 });
    assert.deepEqual(
      blobsOf(calls, THREE),
      ["b.ts"],
      "a resumed scan re-read a file it had already searched",
    );
    assert.equal(result.start, 1);
    assert.equal(result.files_scanned, 1);
    assert.equal(result.next_start, 2);
    assert.equal(result.items[0]?.path, "b.ts");
  });
});

test("the last page is not reported as truncated", async () => {
  // After the third file nothing is left, so truncated must be false and next_start absent; a cap that reports more work sends a caller into an endless resume.
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxFiles: 1, start: 2 });
    assert.deepEqual(blobsOf(calls, THREE), ["c.ts"]);
    assert.equal(result.truncated, false);
    assert.equal(result.next_start, undefined);
    assert.equal(result.note, undefined);
  });
});

test("max_results stops the scan too, and says more may exist", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", { maxResults: 1 });
    assert.equal(result.total_results, 1);
    assert.deepEqual(
      blobsOf(calls, THREE),
      ["a.ts"],
      "the result cap did not stop the scan fetching further blobs",
    );
    assert.equal(result.truncated, true);
    assert.match(result.note ?? "", /max_results cap/);
  });
});

test("an uncapped scan of the same tree reads everything, so the caps are what stopped it", async () => {
  await withTree({ paths: THREE, contents: CONTENTS }, async (calls) => {
    const result = await searchCode(makeEnv(), "ns", "needle", {});
    assert.deepEqual(blobsOf(calls, THREE), THREE);
    assert.equal(result.files_scanned, 3);
    assert.equal(result.total_results, 3);
    assert.equal(result.truncated, false);
    // A clean scan carries no unreadable_files, so the field above proves something.
    assert.equal("unreadable_files" in result, false);
  });
});

test("all_repos searches every readable mapped repo against one file budget and names the rest", async () => {
  const mapped: Record<string, string> = {
    a: "owner/one",
    b: "owner/two",
    c: "owner/hidden",
  };
  const env = fakeEnv({
    DB: {
      prepare: () => ({
        bind: (ns: string) => ({
          first: async () => ({
            repos: JSON.stringify([{ repo: mapped[ns], label: "primary" }]),
          }),
        }),
        all: async () => ({
          results: Object.entries(mapped).map(([namespace, repo]) => ({
            namespace,
            repos: JSON.stringify([{ repo, label: "primary" }]),
          })),
        }),
      }),
    },
    APP_KV: fakeKv({ seedToken: true }).kv,
  });
  const routes: Record<string, Route> = {};
  for (const name of ["one", "two"]) {
    routes[`GET /repos/owner/${name}`] = { body: { default_branch: "main" } };
    routes[`GET /repos/owner/${name}/git/trees/main`] = {
      body: tree(["package.json"]),
    };
    routes[`GET /repos/owner/${name}/git/blobs/sha0`] = {
      body: blob('"left-pad": "1"'),
    };
  }
  await withFetch(routes, async () => {
    const r = await searchAllRepos(env, "left-pad", {
      maxFiles: 1,
      readable: (m) => m.namespace !== "c",
    });
    assert.deepEqual(
      r.items.map((i) => i.repo),
      ["owner/one"],
    );
    assert.equal(r.truncated, true);
    assert.deepEqual(r.not_searched, ["owner/two"]);
    assert.ok(
      toolOutput(["search_code"]).safeParse(r).success,
      "the served output schema refuses it",
    );
  });
});
