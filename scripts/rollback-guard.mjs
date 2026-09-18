// SHOULD THE LIVE GATE'S ROLLBACK ACTUALLY ROLL ANYTHING BACK?
//
// The rollback step exists to undo THE DEPLOY THIS RUN SHIPPED when the live gate
// refuses it. Its `if:` condition could not express that, and on 2026-09-18 that cost
// this repo an unintended production change.
//
// What happened, measured from run 35300342260 and `wrangler deployments list`:
//
//   02:43:31  attempt 1 deploys 4df1274
//   02:43:59  attempt 1's gate crashes on a transient ECONNRESET; rollback #1 runs and
//             lands ede77f4e (376eecb3), the previous good version
//   02:48:09  the seat reruns ONLY the failed live job. `needs.deploy.result` is still
//             'success' from attempt 1, so the condition holds and rollback #2 runs.
//             "The previous version" is now 32920323, which is the 4df1274 build the
//             first rollback had just backed out. Production moved FORWARD onto the
//             commit the gate had refused.
//
// A rollback of a deploy that is no longer live is wrong by definition, whichever
// direction it happens to move production. So the decision is made here, against what
// /health actually reports, rather than against a job result that a rerun preserves.
//
// Usage from the workflow:
//
//   node scripts/rollback-guard.mjs "<live sha from /health>" "<this run's GITHUB_SHA>"
//
// Exit 0 means roll back: the sha live right now is the one this run shipped. Exit 1
// means do not, and the reason is printed. Exit 2 means the guard could not run, which
// is NOT permission to roll back.

import { pathToFileURL } from "node:url";

/**
 * @param {string} liveSha the sha /health reports right now
 * @param {string} runSha this run's own commit
 * @returns {{ roll: boolean, reason: string }}
 */
export function shouldRollBack(liveSha, runSha) {
  const live = String(liveSha ?? "").trim().toLowerCase();
  const mine = String(runSha ?? "").trim().toLowerCase();

  if (!mine) {
    return { roll: false, reason: "this run's own commit was not supplied, so there is nothing to compare the live sha against." };
  }
  // UNREADABLE IS A REFUSAL, NOT A ROLLBACK. The step's own reader writes these two
  // words when /health does not answer or does not parse. A rollback is a production
  // change, and one made without knowing what is live is the move that caused the
  // incident this guard exists to stop. It refuses loudly and leaves it to a human.
  if (!live || live === "unknown" || live === "unreadable") {
    return {
      roll: false,
      reason: `/health reported '${liveSha}', so what is live cannot be established. Refusing to roll back rather than moving production blind. A human decides this one.`,
    };
  }
  // Either may be abbreviated: /health serves the full sha today, but the comparison
  // should not depend on that.
  const same = live.startsWith(mine) || mine.startsWith(live);
  if (!same) {
    return {
      roll: false,
      reason: `what is live is ${live}, not this run's commit ${mine}. The deploy this run shipped is already gone, so rolling back would move production off somebody else's deploy. This is the rerun case: it is what put the refused commit back into production on 2026-09-18.`,
    };
  }
  return { roll: true, reason: `${live} is live and is this run's own commit, so the deploy this run shipped is the one being rolled back.` };
}

// Skipped when imported by the test, the same check scripts/test-budget.mjs uses.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , liveSha, runSha] = process.argv;
  try {
    const verdict = shouldRollBack(liveSha ?? "", runSha ?? "");
    console.log(verdict.reason);
    process.exit(verdict.roll ? 0 : 1);
  } catch (err) {
    console.error(`rollback-guard could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
