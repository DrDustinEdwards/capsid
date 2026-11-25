import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Cloudflare platform pins (capsid/references/cloudflare-changes-2026-09.md). Each
// block guards one platform deadline or contract, so a regression is a failing
// test rather than an outage on the deadline day.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// compatibility date and toolchain pins

test("wrangler.jsonc.example and bindings.mjs agree on the compatibility date", () => {
  const example = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");
  const inExample = /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/.exec(example);
  assert.ok(inExample, "wrangler.jsonc.example no longer sets compatibility_date");
  const bindings = readFileSync(join(ROOT, "scripts", "bindings.mjs"), "utf8");
  const inBindings = /export const COMPATIBILITY_DATE = "(\d{4}-\d{2}-\d{2})"/.exec(bindings);
  assert.ok(inBindings, "scripts/bindings.mjs no longer exports COMPATIBILITY_DATE");
  assert.equal(
    inExample[1],
    inBindings[1],
    "the example and bindings.mjs disagree on the compatibility date",
  );
  // The date must stay at or past nodejs_compat's default-on threshold, so the
  // explicit flag in the example stays redundant rather than required.
  assert.ok(
    inExample[1] >= "2026-08-04",
    `compatibility date ${inExample[1]} fell behind the nodejs_compat default threshold`,
  );
});

// the per-invocation CPU ceiling

test("wrangler.jsonc.example and bindings.mjs agree on limits.cpu_ms", () => {
  // CI writes wrangler.jsonc from the example; the scripts read bindings.mjs. Two
  // spellings of one number, pinned textually (bindings.mjs is untyped .mjs) so a
  // retune of one cannot silently leave the other.
  const example = readFileSync(join(ROOT, "wrangler.jsonc.example"), "utf8");
  const inExample = /"limits":\s*\{\s*"cpu_ms":\s*(\d+)\s*\}/.exec(example);
  assert.ok(
    inExample,
    "wrangler.jsonc.example no longer sets limits.cpu_ms: the runaway guard is gone",
  );
  const bindings = readFileSync(join(ROOT, "scripts", "bindings.mjs"), "utf8");
  const inBindings = /export const LIMITS = \{ cpu_ms: (\d+) \}/.exec(bindings);
  assert.ok(inBindings, "scripts/bindings.mjs no longer exports LIMITS.cpu_ms");
  assert.equal(
    Number(inExample[1]),
    Number(inBindings[1]),
    "wrangler.jsonc.example and scripts/bindings.mjs disagree on cpu_ms",
  );
  // Sanity floor: the ceiling must clear the largest measured invocation (the
  // 1390ms backup) or the guard kills the backup it exists to protect.
  assert.ok(
    Number(inBindings[1]) >= 1390 * 1.5,
    `cpu_ms ${inBindings[1]} is under the measured backup ceiling plus headroom`,
  );
});
