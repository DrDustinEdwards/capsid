// SHOULD THE LIVE GATE'S ROLLBACK ACTUALLY ROLL ANYTHING BACK?
//
// The rollback step exists to undo THE DEPLOY THIS RUN SHIPPED when the live gate
// refuses it. A workflow `if:` on `needs.deploy.result` cannot express that: a rerun of
// only the live job keeps attempt 1's 'success', so a second rollback would move
// production onto whatever "the previous version" now is, which can be the refused
// commit. A rollback of a deploy that is no longer live is wrong in either direction,
// so the decision is made here, against what /health reports.
//
// Usage from the workflow:
//
//   node scripts/rollback-guard.mjs "<live sha from /health>" "<this run's GITHUB_SHA>" \
//     "<run_attempt the deploy job ran in>" "<this run_attempt>"
//
// Exit 0 means roll back. Exit 1 means do not, and the reason is printed. Exit 2 means
// the guard could not run, which is NOT permission to roll back.
//
//   node scripts/rollback-guard.mjs --after "<live sha after the rollback>" "<GITHUB_SHA>"
//
// Exit 0 means the rollback took effect: a readable sha other than this run's is live.
// Exit 1 means it did not, or that what is live cannot be read.

import { pathToFileURL } from "node:url";

// A sha is at least 7 hex characters. A shorter value from /health would prefix-match
// almost anything, so it counts as unreadable.
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * @param {string} liveSha the sha /health reports right now
 * @param {string} runSha this run's own commit
 * @param {{ deployAttempt?: string, runAttempt?: string }} [attempts] the run_attempt the
 *   deploy job ran in, and this job's run_attempt
 * @returns {{ roll: boolean, reason: string }}
 */
export function shouldRollBack(liveSha, runSha, attempts = {}) {
  const live = String(liveSha ?? "").trim().toLowerCase();
  const mine = String(runSha ?? "").trim().toLowerCase();

  if (!SHA.test(mine)) {
    return { roll: false, reason: "this run's own commit was not supplied as a sha, so there is nothing to compare the live sha against." };
  }
  // UNREADABLE: /health did not answer, did not parse, or carried no sha. When the
  // deploy job ran in this same attempt, this attempt shipped the version now serving,
  // and a deploy that broke /health most needs rolling back. In a rerun, or when the
  // attempts are not supplied, it refuses and leaves it to a human.
  if (!SHA.test(live)) {
    const deploy = String(attempts.deployAttempt ?? "").trim();
    const current = String(attempts.runAttempt ?? "").trim();
    if (deploy && deploy === current) {
      return {
        roll: true,
        reason: `/health reported '${liveSha}', not a sha, and the deploy job ran in this attempt (${current}), so what is serving is this attempt's deploy. Rolling it back.`,
      };
    }
    return {
      roll: false,
      reason: `/health reported '${liveSha}', so what is live cannot be established, and the deploy job ran in attempt '${deploy}', not this attempt '${current}'. Refusing to roll back rather than moving production blind. A human decides this one.`,
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

/**
 * Did the rollback take effect? Only a readable sha other than this run's says so.
 * @param {string} afterSha the sha /health reports after the rollback
 * @param {string} runSha this run's own commit
 * @returns {{ moved: boolean, reason: string }}
 */
export function rollbackTookEffect(afterSha, runSha) {
  const after = String(afterSha ?? "").trim().toLowerCase();
  const mine = String(runSha ?? "").trim().toLowerCase();
  if (!SHA.test(after)) {
    return { moved: false, reason: `/health reports '${afterSha}' after the rollback, so it cannot be shown that the rollback took effect.` };
  }
  if (!SHA.test(mine)) {
    return { moved: false, reason: "this run's own commit was not supplied as a sha, so there is nothing to compare against." };
  }
  if (after.startsWith(mine) || mine.startsWith(after)) {
    return { moved: false, reason: `${after} is still live after the rollback: the rollback did not take effect.` };
  }
  return { moved: true, reason: `${after} is live after the rollback.` };
}

// Skipped when imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === "--after") {
      const after = rollbackTookEffect(args[1] ?? "", args[2] ?? "");
      console.log(after.reason);
      process.exit(after.moved ? 0 : 1);
    }
    const [liveSha, runSha, deployAttempt, runAttempt] = args;
    const verdict = shouldRollBack(liveSha ?? "", runSha ?? "", { deployAttempt, runAttempt });
    console.log(verdict.reason);
    process.exit(verdict.roll ? 0 : 1);
  } catch (err) {
    console.error(`rollback-guard could not run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
