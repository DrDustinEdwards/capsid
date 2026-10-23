// Test on the base (docs/work-queue.md, "CI on complete"; Grok design review 2026-10-23,
// build step 4). Run by .github/workflows/test-on-base.yml on a capsid pull request
// labelled test-on-base, which a job opts into with a TEST ON BASE line in its body.
//
//   node scripts/test-on-base.mjs <base-sha> <head-sha>
//
// The pull request's test changes alone (every added or modified file under test/ and
// test-integration/) are laid on the base, and its test files are run there and on the
// head. Green CI on the head shows the tests pass; this shows they test the change: at
// least one of them must fail on the base, and every one that failed there must pass on
// the head. A test file that does not load on the base (it imports code the pull request
// adds) is a collection error and counts for nothing either way. The verdict goes to the
// step summary, and the exit code is the check's conclusion.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [base, head] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(base ?? "") || !/^[0-9a-f]{40}$/.test(head ?? "")) {
  console.error("usage: node scripts/test-on-base.mjs <base-sha> <head-sha>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const TEST_DIR = /^(test|test-integration)\//;
const TEST_FILE = /^(test|test-integration)\/[^/]+\.test\.ts$/;
const DOC = /^docs\/|\.(md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;

function finish(ok, lines) {
  const text = `### Test on the base\n\n${lines.join("\n")}\n`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exit(ok ? 0 : 1);
}

const from = git("merge-base", base, head);
const changed = git("diff", "--name-status", "--no-renames", from, head)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"));
const kept = changed.filter(([status]) => status !== "D").map(([, file]) => file);
const testChanges = kept.filter((f) => TEST_DIR.test(f));
const testFiles = testChanges.filter((f) => TEST_FILE.test(f));
const code = kept.filter((f) => !TEST_DIR.test(f) && !DOC.test(f));
if (code.length === 0) finish(true, ["The pull request changes no code, so there is nothing for a test to show."]);
if (testFiles.length === 0) finish(false, [`The pull request changes code (${code.slice(0, 3).join(", ")}) and no test file, so no test shows the change.`]);

// One file at a time, so every result is keyed by its file. Unit files run under node:test
// and report JUnit; integration files run under vitest and report JSON.
function runTests(dir, files) {
  const results = new Map();
  const notLoaded = [];
  const out = mkdtempSync(path.join(tmpdir(), "tob-"));
  for (const file of files) {
    const report = path.join(out, `${file.replace(/\W/g, "_")}.out`);
    if (file.startsWith("test/")) {
      spawnSync(process.execPath, ["--import", "./test/resolve-ts.mjs", "--test", "--test-reporter=junit", `--test-reporter-destination=${report}`, file], { cwd: dir, stdio: "inherit" });
      const xml = readOr(report);
      const cases = [...xml.matchAll(/<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
      // A file that did not load is reported as one case named for the file.
      if (cases.length === 0 || cases.some((c) => c[1] === file)) notLoaded.push(file);
      for (const c of cases) if (c[1] !== file) results.set(`${file} :: ${unescape(c[1])}`, /<failure/.test(c[3] ?? "") ? "failed" : /<skipped/.test(c[3] ?? "") ? "skipped" : "passed");
    } else {
      spawnSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${report}`, file], { cwd: dir, stdio: "inherit" });
      let json;
      try {
        json = JSON.parse(readOr(report));
      } catch {
        notLoaded.push(file);
        continue;
      }
      for (const suite of json.testResults ?? []) {
        const assertions = suite.assertionResults ?? [];
        if (assertions.length === 0) notLoaded.push(file);
        for (const a of assertions) results.set(`${file} :: ${a.fullName}`, a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped");
      }
    }
  }
  return { results, notLoaded };
}

function readOr(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function unescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// The base with the pull request's test changes laid on it, and nothing else of it.
const baseDir = mkdtempSync(path.join(tmpdir(), "base-"));
git("worktree", "add", "--detach", baseDir, from);
for (const file of testChanges) {
  mkdirSync(path.dirname(path.join(baseDir, file)), { recursive: true });
  writeFileSync(path.join(baseDir, file), execFileSync("git", ["show", `${head}:${file}`]));
}
execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: baseDir, stdio: "inherit" });

const onBase = runTests(baseDir, testFiles);
const onHead = runTests(process.cwd(), testFiles);

const failedOnBase = [...onBase.results].filter(([, s]) => s === "failed").map(([k]) => k);
const lines = [];
if (onBase.notLoaded.length) lines.push(`Did not load on the base, so not counted: ${onBase.notLoaded.join(", ")}.`);
if (failedOnBase.length === 0) {
  finish(false, [...lines, `No test in ${testFiles.join(", ")} failed on the base ${from.slice(0, 7)}, so none of them shows the change.`]);
}
const notPassing = failedOnBase.filter((k) => onHead.results.get(k) !== "passed");
if (notPassing.length) {
  finish(false, [...lines, `Failed on the base and did not pass on the head ${head.slice(0, 7)}:`, ...notPassing.map((k) => `- ${k}`)]);
}
finish(true, [...lines, `Failed on the base ${from.slice(0, 7)} and pass on the head ${head.slice(0, 7)}:`, ...failedOnBase.map((k) => `- ${k}`)]);
