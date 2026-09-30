import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EXPORT_TABLES,
  ORIGIN_DEFAULT,
  PAGE_LIMIT,
  canonicalJson,
  ensureEmptyDir,
  exportClaims,
  fetchCapsidSha,
  fetchTable,
  parseArgs,
  parsePage,
  run,
  scrub,
  sha256Hex,
  toJsonl,
  verifyExport,
  type Row,
} from "../scripts/export-claims.mjs";

// scripts/export-claims.mjs: the claims dataset, one JSONL file per table with a
// manifest that hashes each file. Driven through a fake `claims` tool, and end to end
// through the real capsidClient with a fake fetch, so the key's path is the real one.

const ORIGIN = "https://capsid.example.com";
const KEY = "capsid_k_sample_0123456789abcdef";

type Call = { table: string; after?: number; limit: number };

// A fake `claims` tool serving each table from a list of pages. Page i answers the
// call whose `after` is the cursor page i-1 returned.
function fakeTool(pages: Record<string, Array<{ rows: Row[]; next_after: number | null }>>) {
  const calls: Call[] = [];
  const served: Record<string, number> = {};
  const tool = async (name: string, args: object) => {
    assert.equal(name, "claims");
    const a = args as { action: string; table: string; after?: number; limit: number };
    assert.equal(a.action, "export");
    calls.push({ table: a.table, after: a.after, limit: a.limit });
    const i = served[a.table] ?? 0;
    served[a.table] = i + 1;
    const list = pages[a.table] ?? [{ rows: [], next_after: null }];
    const page = list[i];
    assert.ok(page, `${a.table} was asked for page ${i}, and there are ${list.length}`);
    return JSON.stringify(page);
  };
  return { tool, calls };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "export-claims-"));
}

function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = tempDir();
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

const CLAIM_PAGES = {
  job_claims: [
    { rows: [{ id: 1, job_id: "job_000000000001", namespace: "sample", tests_run: null }, { id: 2, job_id: "job_000000000002", namespace: "sample", tests_run: 4 }], next_after: 2 },
    { rows: [{ id: 3, job_id: "job_000000000003", namespace: "sample", tests_run: 0 }], next_after: 3 },
    { rows: [], next_after: null },
  ],
  job_evaluations: [{ rows: [{ id: 1, job_id: "job_000000000001", name: "pr_merged", agreement: "unclaimed" }], next_after: null }],
  job_touches: [{ rows: [], next_after: null }],
  job_outcomes: [{ rows: [{ job_id: "job_000000000001", agent: "agent:sample-driver", prs_merged: null }], next_after: null }],
};

// ---- paging ---------------------------------------------------------------------

test("the four tables are the claims dataset, in a fixed order", () => {
  assert.deepEqual(EXPORT_TABLES, ["job_claims", "job_evaluations", "job_touches", "job_outcomes"]);
  assert.ok(ORIGIN_DEFAULT.startsWith("https://"));
});

test("pages are concatenated in order, and each page asks after the previous cursor", async () => {
  const { tool, calls } = fakeTool(CLAIM_PAGES);
  const rows = await fetchTable(tool, "job_claims");
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(calls, [
    { table: "job_claims", after: undefined, limit: PAGE_LIMIT },
    { table: "job_claims", after: 2, limit: PAGE_LIMIT },
    { table: "job_claims", after: 3, limit: PAGE_LIMIT },
  ]);
});

test("PLANT: a cursor that does not advance is refused rather than looped on", async () => {
  const { tool } = fakeTool({
    job_claims: [
      { rows: [{ id: 5 }], next_after: 5 },
      { rows: [{ id: 5 }], next_after: 5 },
    ],
  });
  await assert.rejects(fetchTable(tool, "job_claims"), /does not advance past 5/);
  const empty = fakeTool({ job_claims: [{ rows: [], next_after: 9 }] });
  await assert.rejects(fetchTable(empty.tool, "job_claims"), /empty page with next_after 9/);
});

test("a page in a shape the script does not know is refused, naming the table", () => {
  assert.throws(() => parsePage("not json", "job_touches"), /job_touches did not answer with JSON/);
  assert.throws(() => parsePage(JSON.stringify({ items: [] }), "job_touches"), /no rows array/);
  // An absent next_after is not null: the export would stop after one page.
  assert.throws(() => parsePage(JSON.stringify({ rows: [] }), "job_touches"), /next_after is undefined/);
  assert.throws(() => parsePage(JSON.stringify({ rows: [], next_after: "7" }), "job_touches"), /not an integer or null/);
  assert.throws(() => parsePage(JSON.stringify({ rows: [1], next_after: null }), "job_touches"), /row 0 of the page is not an object/);
});

// ---- the files and the manifest ------------------------------------------------

test("JSONL has one row per line, keys sorted, and a null stays null", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: null, b: 2 } }), '{"a":{"b":2,"y":null},"z":1}');
  assert.equal(toJsonl([]), "");
  const text = toJsonl([{ tests_run: null, id: 1 }, { id: 2, tests_run: 0 }]);
  assert.equal(text, '{"id":1,"tests_run":null}\n{"id":2,"tests_run":0}\n');
});

test("an export writes every table, and the manifest's hashes and counts match the files", async () => {
  await withDir(async (root) => {
    const out = join(root, "export");
    const { tool } = fakeTool(CLAIM_PAGES);
    const now = new Date("2026-09-29T12:00:00.000Z");
    const manifest = await exportClaims({ tool, origin: ORIGIN, capsidSha: "abc1234", outDir: out, now });

    assert.equal(manifest.generated_at, "2026-09-29T12:00:00.000Z");
    assert.equal(manifest.origin, ORIGIN);
    assert.equal(manifest.capsid_sha, "abc1234");
    assert.deepEqual(Object.keys(manifest.tables), EXPORT_TABLES);
    assert.deepEqual(
      Object.fromEntries(Object.entries(manifest.tables).map(([t, e]) => [t, e.rows])),
      { job_claims: 3, job_evaluations: 1, job_touches: 0, job_outcomes: 1 }
    );
    for (const [table, entry] of Object.entries(manifest.tables)) {
      assert.equal(entry.file, `${table}.jsonl`);
      const bytes = readFileSync(join(out, entry.file));
      assert.equal(sha256Hex(bytes), entry.sha256, `${table}'s hash does not match its file`);
    }
    // The pages are concatenated in order in the file too.
    const lines = readFileSync(join(out, "job_claims.jsonl"), "utf8").trimEnd().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2, 3]);
    assert.equal(readFileSync(join(out, "job_touches.jsonl"), "utf8"), "");

    const manifestBytes = readFileSync(join(out, "manifest.json"));
    assert.deepEqual(JSON.parse(manifestBytes.toString("utf8")), manifest);
    assert.equal(readFileSync(join(out, "manifest.sha256"), "utf8"), `${sha256Hex(manifestBytes)}  manifest.json\n`);
    assert.deepEqual(readdirSync(out).sort(), [...EXPORT_TABLES.map((t) => `${t}.jsonl`), "manifest.json", "manifest.sha256"].sort());
  });
});

test("a table that fails partway through writes nothing at all", async () => {
  await withDir(async (root) => {
    const out = join(root, "export");
    const tool = async (_name: string, args: object) => {
      if ((args as { table: string }).table === "job_touches") throw new Error("claims refused: planted");
      return JSON.stringify({ rows: [{ id: 1 }], next_after: null });
    };
    await assert.rejects(exportClaims({ tool, origin: ORIGIN, capsidSha: "abc1234", outDir: out }), /planted/);
    assert.equal(existsSync(out), false, "a partial export was left behind");
  });
});

// ---- the output directory ------------------------------------------------------

test("PLANT: a non-empty output directory is refused before any request", async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, "keep.txt"), "an earlier file");
    assert.throws(() => ensureEmptyDir(dir), /is not empty/);
    const { tool, calls } = fakeTool(CLAIM_PAGES);
    await assert.rejects(exportClaims({ tool, origin: ORIGIN, capsidSha: "abc1234", outDir: dir }), /is not empty/);
    assert.equal(calls.length, 0, "the tool was called for a directory that was refused");
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "an earlier file");
  });
});

test("an absent or empty directory is accepted", async () => {
  await withDir((dir) => {
    ensureEmptyDir(dir);
    ensureEmptyDir(join(dir, "not-yet"));
  });
});

// ---- verify --------------------------------------------------------------------

async function writtenExport(root: string): Promise<string> {
  const out = join(root, "export");
  const { tool } = fakeTool(CLAIM_PAGES);
  await exportClaims({ tool, origin: ORIGIN, capsidSha: "abc1234", outDir: out });
  return out;
}

test("--verify passes on the directory an export wrote", async () => {
  await withDir(async (root) => {
    const out = await writtenExport(root);
    assert.deepEqual(verifyExport(out), []);
  });
});

test("PLANT: verify fails when a byte of an export file changes", async () => {
  await withDir(async (root) => {
    const out = await writtenExport(root);
    const path = join(out, "job_claims.jsonl");
    const bytes = readFileSync(path);
    // Flip one digit of one row, keeping the line count, so only the hash can catch it.
    const at = bytes.indexOf("4".charCodeAt(0));
    assert.ok(at >= 0, "the fixture carries no '4' to change");
    bytes[at] = "5".charCodeAt(0);
    writeFileSync(path, bytes);
    const problems = verifyExport(out);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /job_claims\.jsonl \(job_claims\) does not match its sha256/);
  });
});

test("PLANT: verify fails when a listed file is missing", async () => {
  await withDir(async (root) => {
    const out = await writtenExport(root);
    rmSync(join(out, "job_touches.jsonl"));
    const problems = verifyExport(out);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /job_touches\.jsonl \(job_touches\) is listed in manifest\.json and missing/);
  });
});

test("PLANT: verify fails when the manifest is edited without its hash", async () => {
  await withDir(async (root) => {
    const out = await writtenExport(root);
    const path = join(out, "manifest.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"abc1234"', '"def5678"'));
    assert.match(verifyExport(out).join("\n"), /manifest\.json does not match the hash in manifest\.sha256/);
  });
});

test("verify fails on a missing manifest, a dropped table and a file name that leaves the directory", async () => {
  await withDir(async (root) => {
    const out = await writtenExport(root);
    rmSync(join(out, "manifest.sha256"));
    const path = join(out, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    delete manifest.tables.job_outcomes;
    manifest.tables.job_touches.file = "../job_touches.jsonl";
    writeFileSync(path, JSON.stringify(manifest));
    const problems = verifyExport(out).join("\n");
    assert.match(problems, /manifest\.sha256 is missing/);
    assert.match(problems, /does not list job_outcomes/);
    assert.match(problems, /job_touches: the manifest's file "\.\.\/job_touches\.jsonl" is not a file name/);

    rmSync(path);
    assert.deepEqual(verifyExport(out), [`manifest.json is missing from ${out}`]);
  });
});

// ---- the command, end to end, and the key --------------------------------------

type Sent = { method?: string; id?: number; params?: { name?: string; arguments?: { table?: string; after?: number } } };

// A Worker behind a fake fetch: /health answers the sha, /ops/mcp answers JSON-RPC
// with the `claims` pages. `answer` may override a tools/call.
function fakeWorker(answer?: (msg: Sent) => { status?: number; body: string } | undefined) {
  const { tool } = fakeTool(CLAIM_PAGES);
  const auth: string[] = [];
  const impl = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (url === `${ORIGIN}/health`) return new Response(JSON.stringify({ status: "ok", sha: "abc1234" }));
    assert.equal(url, `${ORIGIN}/ops/mcp`);
    auth.push(init?.headers?.Authorization ?? "");
    const msg = JSON.parse(init?.body ?? "{}") as Sent;
    const override = answer?.(msg);
    if (override) return new Response(override.body, { status: override.status ?? 200 });
    if (msg.method === "tools/call") {
      const text = await tool(msg.params?.name ?? "", { action: "export", ...msg.params?.arguments });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  }) as unknown as typeof fetch;
  return { impl, auth };
}

async function runCaptured(argv: string[], env: Record<string, string | undefined>, fetchImpl?: typeof fetch) {
  const lines: string[] = [];
  const code = await run({ argv, env, fetchImpl, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

test("the command exports through the real client, carrying the key only in the header", async () => {
  await withDir(async (root) => {
    const out = join(root, "export");
    const { impl, auth } = fakeWorker();
    const { code, text } = await runCaptured(["--out", out], { CAPSID_OPERATOR_KEY: KEY, CAPSID_ORIGIN: ORIGIN }, impl);
    assert.equal(code, 0, text);
    assert.ok(auth.length > 0 && auth.every((a) => a === `Bearer ${KEY}`));
    assert.equal(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).capsid_sha, "abc1234");
    assert.equal(text.includes(KEY), false, "the key was printed");
    for (const file of readdirSync(out)) {
      assert.equal(readFileSync(join(out, file), "utf8").includes(KEY), false, `the key was written into ${file}`);
    }
    const verified = await runCaptured(["--verify", out], {});
    assert.equal(verified.code, 0, verified.text);
  });
});

test("PLANT: the key never appears in a reported error, even when the server echoes it", async () => {
  await withDir(async (root) => {
    const { impl } = fakeWorker((msg) =>
      msg.method === "tools/call" ? { status: 401, body: `invalid bearer ${KEY}` } : undefined
    );
    const { code, text } = await runCaptured(["--out", join(root, "export")], { CAPSID_OPERATOR_KEY: KEY, CAPSID_ORIGIN: ORIGIN }, impl);
    assert.equal(code, 1);
    assert.match(text, /HTTP 401: invalid bearer <CAPSID_OPERATOR_KEY>/);
    assert.equal(text.includes(KEY), false, "the key was printed in an error");
  });
  assert.equal(scrub(`a ${KEY} b ${KEY}`, KEY), "a <CAPSID_OPERATOR_KEY> b <CAPSID_OPERATOR_KEY>");
  assert.equal(scrub("nothing to hide", undefined), "nothing to hide");
});

test("no key, an http origin, or a bad /health each refuse, and nothing is written", async () => {
  await withDir(async (root) => {
    const out = join(root, "export");
    const none = await runCaptured(["--out", out], {});
    assert.equal(none.code, 2);
    assert.match(none.text, /CAPSID_OPERATOR_KEY is not set/);

    const http = await runCaptured(["--out", out], { CAPSID_OPERATOR_KEY: KEY, CAPSID_ORIGIN: "http://capsid.example.com" });
    assert.equal(http.code, 1);
    assert.match(http.text, /must be https/);
    assert.equal(http.text.includes(KEY), false);

    const noSha = (async () => new Response(JSON.stringify({ status: "ok" }))) as unknown as typeof fetch;
    await assert.rejects(fetchCapsidSha(ORIGIN, noSha), /\/health carried no sha/);
    const down = (async () => new Response("gone", { status: 503 })) as unknown as typeof fetch;
    const failed = await runCaptured(["--out", out], { CAPSID_OPERATOR_KEY: KEY, CAPSID_ORIGIN: ORIGIN }, down);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /\/health -> HTTP 503/);
    assert.equal(existsSync(out), false);
  });
});

test("the command's arguments: one of --out or --verify, each with a directory", () => {
  assert.deepEqual(parseArgs(["--out", "x"]), { out: "x", verify: undefined });
  assert.deepEqual(parseArgs(["--verify", "x"]), { out: undefined, verify: "x" });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["--out"]), /--out needs a directory/);
  assert.throws(() => parseArgs(["--verify"]), /--verify needs/);
  assert.throws(() => parseArgs(["--out", "a", "--verify", "b"]), /one or the other/);
});
