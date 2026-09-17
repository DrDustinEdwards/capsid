// Runs the unit suite and reports its wall clock. On CI, fails the run when the
// suite takes longer than the budget.
//
// The time is measured here, around the one node --test process, so it is measured
// the same way on every run. The budget is enforced only when CI is "true" (GitHub
// Actions sets it), because a local machine can be several times slower than the
// runner: measured 2026-09-17, the runner took 39 to 43 seconds while a four-core
// Windows host took 167.
//
// There is no override. A budget that an environment variable can raise is not a
// budget.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BUDGET_MS = 60_000;

/**
 * @param {number} ms the suite's wall clock
 * @param {string | undefined} ci the CI environment variable
 * @returns {{ fail: boolean, message: string }}
 */
export function verdict(ms, ci) {
  const seconds = (ms / 1000).toFixed(1);
  const enforced = ci === "true";
  if (ms > BUDGET_MS && enforced) {
    return {
      fail: true,
      message: `unit suite took ${seconds}s, over the ${BUDGET_MS / 1000}s budget. Make the slow files faster; test/*.test.ts timings are in the output above.`,
    };
  }
  return {
    fail: false,
    message: `unit suite took ${seconds}s (budget ${BUDGET_MS / 1000}s, ${enforced ? "enforced" : "enforced only when CI=true"}).`,
  };
}

function main() {
  const started = performance.now();
  const run = spawnSync(process.execPath, ["--import", "./test/resolve-ts.mjs", "--test", ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  const ms = performance.now() - started;
  if (run.error) throw run.error;
  const result = verdict(ms, process.env.CI);
  // A failing suite fails for its own reason first; the time is still reported.
  (result.fail ? console.error : console.log)(result.message);
  if (run.status !== 0) process.exit(run.status ?? 1);
  if (result.fail) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
