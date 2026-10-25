import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sourceFile } from "./source-files.ts";

// The configuration and the handler must agree. wrangler.jsonc.example declares
// which crons fire; src/index.ts decides what to do when one does. A cron declared
// and not handled is a wasted invocation; a cron handled and not declared is a
// subsystem that never runs. Both are silent, so the two lists are derived from
// each other here.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

function declaredCrons(): string[] {
  const example = read("../wrangler.jsonc.example");
  const line = /"crons":\s*\[([^\]]+)\]/.exec(example);
  assert.ok(line, "wrangler.jsonc.example no longer declares a crons array");
  const crons = [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // Vacuity guard: an extraction that matched nothing would make both directions
  // below pass over empty lists.
  assert.ok(crons.length > 0, "parsed no cron expressions out of wrangler.jsonc.example");
  return crons;
}

// The handler's list is read from source, not imported: src/index.ts pulls in
// modules that use the `cloudflare:` scheme and fail under node with
// ERR_UNSUPPORTED_ESM_URL_SCHEME.
function handlerConstant(name: string): string {
  const index = sourceFile("index.ts");
  const found = new RegExp(`export const ${name} = "([^"]+)";`).exec(index);
  assert.ok(found, `src/index.ts no longer exports ${name}`);
  return found[1];
}

const BACKUP_CRON = handlerConstant("BACKUP_CRON");
const TICK_CRON = handlerConstant("TICK_CRON");
const SKILLS_REFRESH_CRON = handlerConstant("SKILLS_REFRESH_CRON");

const HANDLED = [BACKUP_CRON, TICK_CRON, SKILLS_REFRESH_CRON];

// scanner-rule: conventions-verification, a list in two places is derived both ways. src/index.ts imports agents/mcp and cannot load under node --test, so its constants and branch shape are read as text. test-integration/scheduled.test.ts imports them and fires each cron
test("every cron the handler dispatches on is declared in the config", () => {
  const declared = declaredCrons();
  const missing = HANDLED.filter((c) => !declared.includes(c));
  assert.deepEqual(missing, [], `src/index.ts handles crons the config never fires: ${missing.join(", ")}`);
});

// scanner-rule: conventions-verification, a list in two places is derived both ways. src/index.ts imports agents/mcp and cannot load under node --test, so its constants and branch shape are read as text. test-integration/scheduled.test.ts imports them and fires each cron
test("every cron the config fires is handled", () => {
  const declared = declaredCrons();
  const unhandled = declared.filter((c) => !HANDLED.includes(c));
  assert.deepEqual(unhandled, [], `wrangler.jsonc.example fires crons nothing handles: ${unhandled.join(", ")}`);
});

// That the three expressions are distinct, and that the handler dispatches on
// controller.cron (each does only its own work, an unrecognized one does nothing, a
// throwing branch does not stop a later cron), is driven in
// test-integration/scheduled.test.ts.
