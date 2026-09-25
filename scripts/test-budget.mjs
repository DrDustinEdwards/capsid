// Runs the unit suite and prints its wall clock.
//
// The time is measured here, around the one node --test process, so it is measured
// the same way on every run.
//
// It used to fail CI past a 60 second budget. That was retired in the 2026-09-25
// audit: in about 439 CI runs it never fired (median 23s, maximum 43s), and a slow
// suite is not harm that cannot be undone. The printed line stays so the time is
// still visible in every log. The file keeps its name because the auto-merge policy
// lists it as the runner behind npm test.

import { spawnSync } from "node:child_process";

const started = performance.now();
const run = spawnSync(process.execPath, ["--import", "./test/resolve-ts.mjs", "--test", ...process.argv.slice(2)], {
  stdio: "inherit",
});
const ms = performance.now() - started;
if (run.error) throw run.error;
console.log(`unit suite took ${(ms / 1000).toFixed(1)}s.`);
process.exit(run.status ?? 1);
