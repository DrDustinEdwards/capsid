import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

// CI writes wrangler.jsonc from the example; the scripts read bindings.mjs. Two spellings of one number each.
test("wrangler.jsonc.example and bindings.mjs agree on the compatibility date and limits.cpu_ms", () => {
  const example = read("wrangler.jsonc.example");
  const bindings = read("scripts/bindings.mjs");
  const date = /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/.exec(example)?.[1];
  assert.equal(date, /export const COMPATIBILITY_DATE = "([\d-]+)"/.exec(bindings)?.[1]);
  // At or past nodejs_compat's default-on date, so the explicit flag stays redundant.
  assert.ok(date && date >= "2026-08-04", `compatibility date ${date}`);
  const cpu = /"limits":\s*\{\s*"cpu_ms":\s*(\d+)\s*\}/.exec(example)?.[1];
  assert.equal(cpu, /export const LIMITS = \{ cpu_ms: (\d+) \}/.exec(bindings)?.[1]);
  // The ceiling must clear the largest measured invocation (the 1390ms backup) with headroom.
  assert.ok(Number(cpu) >= 1390 * 1.5, `cpu_ms ${cpu}`);
});

test("the integration compatibility date is not ahead of the deploy date", () => {
  // The pool's workerd caps behind production; a later date would pass on behavior production does not have.
  const integration = /INTEGRATION_COMPAT_DATE = "([\d-]+)"/.exec(read("vitest.config.ts"))?.[1];
  const deployed = /COMPATIBILITY_DATE = "([\d-]+)"/.exec(read("scripts/bindings.mjs"))?.[1];
  assert.ok(integration && deployed && integration <= deployed, `${integration} vs ${deployed}`);
});
