import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sourceFile } from "./source-files.ts";

// A cron declared and not handled is a wasted invocation; one handled and not declared never
// runs. Both are silent, so each list is derived from the other.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

function declaredCrons(): string[] {
  const example = read("../wrangler.jsonc.example");
  const line = /"crons":\s*\[([^\]]+)\]/.exec(example);
  assert.ok(line, "wrangler.jsonc.example no longer declares a crons array");
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// Read as text: src/index.ts imports `cloudflare:` modules, which node --test cannot load.
function handlerConstant(name: string): string {
  const index = sourceFile("index.ts");
  const found = new RegExp(`export const ${name} = "([^"]+)";`).exec(index);
  assert.ok(found, `src/index.ts no longer exports ${name}`);
  return found[1];
}

// Dispatch on controller.cron is driven in test-integration/scheduled.test.ts.
test("the crons the config fires are exactly the crons the handler dispatches on", () => {
  assert.deepEqual(
    declaredCrons().sort(),
    [handlerConstant("BACKUP_CRON"), handlerConstant("TICK_CRON")].sort(),
  );
});
