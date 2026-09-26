import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// A suite that is never run reads as coverage it does not give, so this asserts from
// the unit suite that the integration suite is typed and in the CI workflow. It does
// not run vitest itself.

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CI = read(".github/workflows/ci.yml");
const CONFIG = read("vitest.config.ts");

test("PLANT: CI runs both suites and typechecks all four configs", () => {
  // Each command either as a step's `run:` or as a whole line of a `run: |` block,
  // which is how the one typecheck step runs all four configs.
  for (const step of ["npm run check", "npm run check:test", "npm run check:integration", "npm run check:scripts", "npm test", "npm run test:integration"]) {
    const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(CI, new RegExp(`^\\s+(run: )?${escaped}( \\|\\| status=1)?$`, "m"), `the CI checks job does not run \`${step}\``);
  }
  // Ordering matters: the deploy job is `needs: checks`, so an integration failure
  // has to be inside that job rather than in a job beside it.
  const checksJob = CI.slice(CI.indexOf("  checks:"), CI.indexOf("  deploy:"));
  assert.ok(checksJob.includes("npm run test:integration"), "the integration suite must be inside the job deploy depends on");
});

test("the integration compatibility date is not AHEAD of the deploy date", () => {
  // The pool's workerd caps at a date behind production, so the two may differ. A
  // suite at a later date than deploys would pass on behaviour production does not have.
  const integration = CONFIG.match(/INTEGRATION_COMPAT_DATE = "([\d-]+)"/)?.[1];
  assert.ok(integration, "the integration compatibility date is not declared where this test can read it");
  const bindings = read("scripts/bindings.mjs");
  const deployed = bindings.match(/COMPATIBILITY_DATE = "([\d-]+)"/)?.[1];
  assert.ok(deployed, "scripts/bindings.mjs no longer declares COMPATIBILITY_DATE where this test can read it");
  assert.ok(
    integration! <= deployed!,
    `the integration suite runs at ${integration}, ahead of the deployed ${deployed}: it would pass on behaviour production does not have`
  );
});

test("no real secret reached the integration bindings", () => {
  // Public repo rule, applied to the one config file that carries secret-shaped values.
  for (const suspicious of [/sk-ant-/, /ghp_/, /github_pat_/, /-----BEGIN/]) {
    assert.doesNotMatch(CONFIG, suspicious, `vitest.config.ts carries something matching ${suspicious}`);
  }
});
