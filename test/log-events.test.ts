import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";

// Every line the Worker logs is a JSON object with an `event` token, written by
// logEvent in src/log.ts. A bare console call would put a free-text line back into
// the log that a search on `event` cannot find, so this scans all of src/ and names
// the file and line of any that comes back.

// Comments are blanked first (keeping the line count) so a sentence that mentions
// console.error does not count as a call.
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const DIRECT = /\bconsole\s*(?:\.\s*(?:log|warn|error|info|debug)\b|\[)/g;

function directCalls(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles()) {
    if (file.name === "log.ts") continue;
    const lines = code(file.text).split("\n");
    lines.forEach((line, i) => {
      if (DIRECT.test(line)) found.push(`src/${file.name}:${i + 1}: ${line.trim()}`);
      DIRECT.lastIndex = 0;
    });
  }
  return found;
}

// A floor read from the code when this was written (86 sites converted). It is
// below the real count so removing a log line is not a test edit, and above zero by
// enough that a scan which matches nothing cannot pass.
const MIN_LOG_EVENT_SITES = 80;

test("no file in src/ other than log.ts calls console.log, warn or error directly", () => {
  const found = directCalls();
  assert.deepEqual(found, [], `log through logEvent (src/log.ts), not console:\n${found.join("\n")}`);
});

test("the scan sees the logEvent call sites, so an empty scan cannot pass the guard above", () => {
  let sites = 0;
  for (const file of sourceFiles()) {
    if (file.name === "log.ts") continue;
    sites += (code(file.text).match(/\blogEvent\(/g) ?? []).length;
  }
  assert.ok(sites >= MIN_LOG_EVENT_SITES, `only ${sites} logEvent call sites found, expected at least ${MIN_LOG_EVENT_SITES}`);
});

test("src/log.ts is the one file that touches console", () => {
  const log = sourceFiles().find((f) => f.name === "log.ts");
  assert.ok(log, "src/log.ts is missing");
  assert.match(code(log.text), /console\[level\]\(/);
});

test("every logEvent call names an upper-case event token", () => {
  const bad: string[] = [];
  for (const file of sourceFiles()) {
    if (file.name === "log.ts") continue;
    for (const m of code(file.text).matchAll(/\blogEvent\(\s*"(log|warn|error)"\s*,\s*([^,]+),/g)) {
      const arg = m[2].trim();
      // A string literal must be ALL_CAPS; a variable or a template is allowed where the token is built.
      if (/^"/.test(arg) && !/^"[A-Z][A-Z0-9_]*"$/.test(arg)) bad.push(`src/${file.name}: ${arg}`);
    }
  }
  assert.deepEqual(bad, []);
});
