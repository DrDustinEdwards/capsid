import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";

// A bare console call puts a free-text, unscrubbed line in a log that a search on `event` cannot find, so
// this scans all of src/ for one and names its file and line.

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
    const lines = code(file.text).split("\n");
    lines.forEach((line, i) => {
      if (DIRECT.test(line)) found.push(`src/${file.name}:${i + 1}: ${line.trim()}`);
      DIRECT.lastIndex = 0;
    });
  }
  return found;
}

function calls(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of sourceFiles()) {
    const src = code(file.text);
    for (const m of src.matchAll(/\blogEvent\(/g)) {
      const end = src.indexOf(");", m.index);
      out.push({ file: file.name, text: src.slice(m.index, end === -1 ? undefined : end + 2) });
    }
  }
  return out;
}

// A floor below the real count, so removing a log line is not a test edit, and above zero so a scan that
// matches nothing cannot pass.
const MIN_LOG_EVENT_SITES = 80;

test("no file in src/ calls console.log, warn or error directly", () => {
  const found = directCalls();
  assert.deepEqual(
    found,
    [],
    `log through logEvent (@dustinedwards/site-runtime/log), not console:\n${found.join("\n")}`,
  );
  assert.ok(
    calls().length >= MIN_LOG_EVENT_SITES,
    `only ${calls().length} logEvent call sites found, expected at least ${MIN_LOG_EVENT_SITES}: the scan reads nothing`,
  );
});

test("every logEvent call names an upper-case event token and carries a message", () => {
  const bad: string[] = [];
  for (const { file, text } of calls()) {
    const arg = /^logEvent\(\s*([^,]+),/.exec(text)?.[1].trim() ?? "";
    if (arg.startsWith('"') && !/^"[A-Z][A-Z0-9_]*"$/.test(arg)) bad.push(`src/${file}: ${arg}`);
    if (!/\bmessage\b/.test(text)) bad.push(`src/${file}: ${arg} has no message`);
  }
  assert.deepEqual(bad, []);
});
