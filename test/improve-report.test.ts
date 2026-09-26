import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { holdoutFilePassed, markers, parseHoldoutStream, parseTestReport, splitStream, testPassRate } from "../scripts/improve-report.mjs";

// The scorer counts holdout passes from node --test's TAP reporter, not from a
// process exit code. An early process.exit, or any truncated or empty report, cannot
// be counted as a pass, so an attempt cannot force holdout_pass_rate to 1.0 by
// exiting 0 before its assertions run.

// A realistic node --test TAP fragment: top-level results at column 0, subtests
// indented under "# Subtest:".
const tap = (lines: string[]) => ["TAP version 13", ...lines].join("\n");
const okLine = (n: number, name: string) => `ok ${n} - ${name}`;
const notOkLine = (n: number, name: string) => `not ok ${n} - ${name}`;
const nestedOk = (name: string) => `    ok 1 - ${name}`; // indented subtest, must NOT count

test("parseTestReport counts top-level ok/not ok, ignoring nested and non-result lines", () => {
  const report = tap([
    "# Subtest: a",
    okLine(1, "a"),
    nestedOk("a.1"),
    "# Subtest: b",
    notOkLine(2, "b"),
    "  ---",
    "  duration_ms: 1",
    "  ...",
    "1..2",
  ]);
  assert.deepEqual(parseTestReport(report), { pass: 1, fail: 1 });
});

test("testPassRate is the ratio, and null when nothing ran", () => {
  assert.equal(testPassRate(tap([okLine(1, "a"), okLine(2, "b"), notOkLine(3, "c")])), 2 / 3);
  assert.equal(testPassRate(""), null, "an empty report is null, not a division by zero or a zero");
  assert.equal(testPassRate("TAP version 13\n"), null, "a header with no results is null");
});

test("holdoutFilePassed requires a real pass and no failure", () => {
  assert.equal(holdoutFilePassed(tap([okLine(1, "case")])), true);
  assert.equal(holdoutFilePassed(tap([okLine(1, "case"), notOkLine(2, "other")])), false);
});

test("an early process.exit(0) cannot be counted as a holdout pass", () => {
  // Attempt code imported by a holdout case calls process.exit(0) before any
  // assertion. No `ok` line is written, so the case is not credited.
  assert.equal(holdoutFilePassed(""), false);
  assert.equal(holdoutFilePassed(tap(["# Subtest: case"])), false, "a started-but-unfinished case is not a pass");
});

// The CLI modes. Each test drives the script as a child process, the way the score
// workflow does, because what matters is what the CLI prints and exits with.

const SCORER = join(import.meta.dirname, "..", "scripts", "improve-report.mjs");
const NONCE = "audit-nonce";
const M = markers(NONCE);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "capsid-improve-report-"));
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCORER, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

const BASE_ENV = {
  IMPROVE_NAMESPACE: "capsid",
  RUN_ID: "r1",
  ATTEMPT_ID: "a1",
  ATTEMPT_HEAD_SHA: "deadbeef",
  BUILD_PASSES: "1",
  SECONDARY_TEST_PASS_RATE: "0.9",
  SECONDARY_LINT_COUNT: "3",
  CI_MINUTES: "4.5",
  ENV_FAILURE: "",
  ENV_FAILURE_REASON: "",
};

function reportBody(
  args: string[],
  env: Record<string, string> = {}
): {
  body: {
    holdout: { total: number; passed: number };
    environment: { ok: boolean; reason: string | null };
    ci_minutes: number | null;
    secondary: Record<string, number | null>;
  };
  stderr: string;
} {
  const result = run(args, { ...BASE_ENV, ...env });
  assert.equal(result.status, 0, result.stderr);
  return { body: JSON.parse(result.stdout), stderr: result.stderr };
}

function metricsFile(contents: string): string {
  const path = join(scratch(), "metrics.json");
  writeFileSync(path, contents);
  return path;
}

test("PLANT 6-1: an unreadable holdout stream prints no count and exits 1", () => {
  const missing = join(scratch(), "no-such-holdout.tap");
  const result = run(["--holdout-stream", missing, NONCE]);
  assert.equal(result.status, 1, "an unreadable stream exited 0, so its count could be used");
  assert.equal(result.stdout, "", "an unreadable stream printed a count");
  assert.match(result.stderr, /could not read the holdout stream/);

  // A readable stream still prints its count.
  const path = join(scratch(), "holdout.tap");
  writeFileSync(path, [`${M.case}a.test.ts`, "ok 1 - a", M.end, ""].join("\n"));
  const ok = run(["--holdout-stream", path, NONCE]);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "1");
});

test("PLANT 6-2: a missing or corrupt metrics.json is named on stderr, and bundle size stays null", () => {
  const missing = reportBody([join(scratch(), "absent.json"), "11", "11"]);
  assert.equal(missing.body.secondary.bundle_size_bytes, null);
  assert.match(missing.stderr, /could not read metrics\.json/);

  const corrupt = reportBody([metricsFile("{not json"), "11", "11"]);
  assert.equal(corrupt.body.secondary.bundle_size_bytes, null);
  assert.match(corrupt.stderr, /metrics\.json .* is not valid JSON/);

  const good = reportBody([metricsFile(JSON.stringify({ bundle_size_bytes: 4242 })), "11", "11"]);
  assert.equal(good.body.secondary.bundle_size_bytes, 4242);
  assert.equal(good.stderr, "", "a readable metrics.json logs nothing");
});

test("PLANT 6-3: a holdout count that is not a non-negative integer is an environment failure with a reason", () => {
  const metrics = metricsFile(JSON.stringify({ bundle_size_bytes: 1 }));
  for (const [total, passed] of [
    ["", "0"],
    ["11", "abc"],
    ["11", "-1"],
    ["11", "1.5"],
  ]) {
    const { body } = reportBody([metrics, total, passed]);
    assert.equal(body.environment.ok, false, `total ${JSON.stringify(total)} passed ${JSON.stringify(passed)} was reported as a healthy run`);
    assert.match(String(body.environment.reason), /holdout count was unreadable/);
    // The body stays one the Worker accepts: two integers.
    assert.ok(Number.isInteger(body.holdout.total) && Number.isInteger(body.holdout.passed));
  }
  // The workflow's own reason wins when it already set one.
  const { body } = reportBody([metrics, "", "0"], { ENV_FAILURE: "1", ENV_FAILURE_REASON: "the holdout container did not finish" });
  assert.match(String(body.environment.reason), /did not finish/);

  const healthy = reportBody([metrics, "11", "7"]).body;
  assert.deepEqual(healthy.environment, { ok: true, reason: null });
  assert.deepEqual(healthy.holdout, { total: 11, passed: 7 });
});

test("PLANT 6-4: an unreadable container stream is reported as unreadable, not as a container that did not finish", () => {
  const dir = scratch();
  const metrics = join(dir, "metrics.json");
  writeFileSync(metrics, "{}");
  const result = run(["--secondary", join(dir, "absent.tap"), "capsid", NONCE, metrics]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^test_pass_rate=\nlint_count=\n$/);
  assert.match(result.stderr, /could not read the container stream/);
  assert.match(result.stderr, /the container stream could not be read/);
  assert.doesNotMatch(result.stderr, /did not finish/, "a read error was reported as a container that did not finish");
});

test("PLANT 6-5: an imports.txt that exists but cannot be read is not reported as missing", () => {
  const dir = scratch();
  const holdout = join(dir, "holdout");
  mkdirSync(holdout);
  writeFileSync(join(holdout, "a.test.ts"), 'import { alpha } from "../src/x.ts";\n');
  // A directory where the file should be: EISDIR on read, which is not ENOENT.
  const manifest = join(dir, "imports.txt");
  mkdirSync(manifest);
  const result = run(["--check-holdout-imports", holdout, "capsid", manifest]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exists but could not be read/);
  assert.doesNotMatch(result.stderr, /Create the file/, "the operator was told to create a file that exists");

  // A file that really is absent still gets the create-it refusal.
  const absent = run(["--check-holdout-imports", holdout, "capsid", join(dir, "nothing.txt")]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /Create the file/);
});

test("PLANT 6-6: an unknown scorer duration is reported as null, never as zero minutes", () => {
  const metrics = metricsFile("{}");
  // "0" is what the workflow sends when started.txt did not arrive.
  for (const value of ["0", "", "x", "-3"]) {
    assert.equal(reportBody([metrics, "11", "11"], { CI_MINUTES: value }).body.ci_minutes, null, `CI_MINUTES=${JSON.stringify(value)}`);
  }
  assert.equal(reportBody([metrics, "11", "11"], { CI_MINUTES: "4.50" }).body.ci_minutes, 4.5);
});

test("PLANT 6-7: the CLI header lists every mode the dispatch table holds, and the count is right", () => {
  const source = readFileSync(SCORER, "utf8");
  const header = source.slice(source.indexOf("// ---- CLI"), source.indexOf("function errorText"));
  const headerFlags = [...header.matchAll(/^\/\/\s+(--[a-z][a-z-]*)/gm)].map((x) => x[1]).sort();
  const table = source.slice(source.indexOf("const MODES = {"), source.indexOf("};", source.indexOf("const MODES = {")));
  const tableFlags = [...table.matchAll(/"(--[a-z-]+)":/g)].map((x) => x[1]).sort();
  assert.ok(tableFlags.length > 0, "no dispatch table was found, so nothing was compared");
  assert.deepEqual(headerFlags, tableFlags, "the header and the dispatch table disagree about the flags");
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const stated = header.match(/^\/\/ (\w+) modes/m)?.[1]?.toLowerCase();
  // Every flag, plus the report mode that takes no flag.
  assert.equal(stated, words[tableFlags.length + 1], `the header says ${stated} modes`);
});

test("PLANT 6-8: a CRLF stream keeps its markers", () => {
  const lines = [`${M.case}a.test.ts`, "ok 1 - a", M.test, "ok 1 - t", `${M.status}0`, M.lint, `${M.status}0`, `${M.end}  `, ""];
  const crlf = lines.join("\r\n");
  const { segments, terminated } = splitStream(crlf, NONCE);
  assert.equal(terminated, true, "a CRLF end marker was not recognised, so the container read as never finished");
  assert.deepEqual(
    segments.map((s) => s.kind),
    ["case", "test", "lint"]
  );
  assert.deepEqual(parseHoldoutStream(crlf, NONCE).cases, [{ name: "a.test.ts", passed: true }]);
});
