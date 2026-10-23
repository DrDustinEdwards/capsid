// Runs test files and reads each test's result, for scripts/test-on-base.mjs and
// scripts/shadow-test.mjs. One file at a time, so every result is keyed by its file. Unit
// files run under node:test and report JUnit; integration files run under vitest and
// report JSON. A file that does not load is listed in notLoaded and has no results.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function runTests(dir, files) {
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

