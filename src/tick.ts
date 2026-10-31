import type { Env } from "./env";
import { autoMergeTick } from "./auto-merge-tick";
import { mergeResumeTick } from "./merge-resume";
import { sweepIfDue } from "./outcome-prs";
import { runTask, type TaskResult } from "./task-runs";
import { watcherTick } from "./watcher";
import { gatherFindings } from "./watcher-gather";
import { maintenanceTick } from "./maintenance";
import { publicBuildTick } from "./public-data";
import { docIndexTick } from "./doc-index";
import { pushTick } from "./push";
import { sitePulseTick } from "./site-pulse";
import { digestTick } from "./digest";
import { unitsTick } from "./merge-units";
import { mergeSafetyTick } from "./merge-safety";
import { logEvent } from "@dustinedwards/site-runtime/log";

// The five-minute tick's steps, in order. Each is its own task in the run ledger
// (src/task-runs.ts): runTask records a run, and records and logs a throw without
// rethrowing it, so one step's throw does not stop the rest of the tick. A step that was
// not due returns null from its judge and records nothing.
export async function runTick(env: Env, now: Date): Promise<void> {
  // Auto-merge. The policy document decides whether it does anything; it ships
  // disabled, and a disabled policy is not a run. A policy that cannot be read or is
  // refused is.
  await runTask(
    env,
    "auto-merge",
    () => autoMergeTick(env, now),
    (merged): TaskResult => {
      if (merged.ran) {
        logEvent("AUTO_MERGE", { message: `AUTO_MERGE ${merged.note}` });
        return { outcome: "ok", reason: merged.note };
      }
      return merged.policy_version === null ? { outcome: "refused", reason: merged.note } : null;
    },
    { tag: "AUTO_MERGE_THREW:", rethrow: false }
  );

  // The watcher, on its own half-hourly stamp. It only posts jobs, so the worst a
  // broken pass can do is add a row to the queue.
  await runTask(
    env,
    "watcher",
    () => watcherTick(env, now, () => gatherFindings(env, now)),
    (watched): TaskResult => {
      if (!watched.ran) return null;
      logEvent("WATCHER", { message: `WATCHER ${watched.note}` });
      return { outcome: "ok", reason: watched.note };
    },
    { tag: "WATCHER_THREW:", rethrow: false }
  );

  // Merge units (src/merge-units.ts): after the watcher, which records rollbacks in
  // deploy_outcomes. It proposes promotions and demotions and suspends a unit whose
  // unattended merge was rolled back; the suspension only narrows, and the auto-merge
  // step reads it on the next tick. Recorded only when something changed.
  await runTask(
    env,
    "merge-units",
    () => unitsTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("MERGE_UNITS", { message: `MERGE_UNITS ${report.note}` }, { level: report.newly_suspended.length ? "error" : "log" });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "MERGE_UNITS_THREW:", rethrow: false }
  );

  // The auto-merge safety meter and shutoff (src/merge-safety.ts): after merge-units. Its
  // revert pass runs at most half-hourly; the counts and the shutoff read D1 only, every
  // tick. A namespace it pauses only narrows: the auto-merge step reads the pause on the
  // next tick. Recorded only when something changed.
  await runTask(
    env,
    "merge-safety",
    () => mergeSafetyTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("MERGE_SAFETY", { message: `MERGE_SAFETY ${report.note}` }, { level: report.newly_paused.length ? "error" : "log" });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "MERGE_SAFETY_THREW:", rethrow: false }
  );

  // Stale jobs: a blocked job whose named pull requests have all merged goes back to its
  // holder with a note. It resumes and never completes; see src/merge-resume.ts. Recorded
  // only when it resumed something, so the ledger is not one empty pass every five minutes.
  await runTask(
    env,
    "merge-resume",
    () => mergeResumeTick(env, now),
    (report): TaskResult => {
      // A stale:prs cache that could not be written is recorded even on a pass that
      // resumed nothing, so the stale view's missing rows have a cause on the ledger.
      if (report.cache_error) {
        logEvent("MERGE_RESUME_CACHE", { message: `MERGE_RESUME_CACHE ${report.note}` }, { level: "error" });
        return { outcome: "refused", reason: report.note };
      }
      if (report.resumed.length === 0) return null;
      logEvent("MERGE_RESUME", { message: `MERGE_RESUME ${report.note}` });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "MERGE_RESUME_THREW:", rethrow: false }
  );

  // The daily maintenance pass (src/maintenance.ts): once a UTC day after 11:00, it lists
  // what has gone stale for the seat's morning read. Its writes are pruning merged
  // branches, off until the seat turns it on, and tagging a shared package's merged version
  // bump (src/maintenance-releases.ts), on until the seat turns it off. Each delete and each
  // tag is audit-logged before the next, so a broken pass costs a missing list, not an
  // unrecorded write. Not due is not a run.
  await runTask(
    env,
    "maintenance",
    () => maintenanceTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("MAINTENANCE", { message: `MAINTENANCE ${report.note}` });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "MAINTENANCE_THREW:", rethrow: false }
  );

  // The public system model (src/public-data.ts): once a UTC day, repo visibility read
  // from GitHub, the model filtered by toPublic and stored for /public/model/v1.json,
  // and the public repos' code maps for /public/code/v1.json, rebuilt hourly. A
  // failed read throws before anything is written, so the last good document stays
  // served and the ledger shows the failure. Not due is not a run.
  await runTask(
    env,
    "public-build",
    () => publicBuildTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      // A code map that would not parse is a refusal the ledger shows; the model was still built.
      const failed = "codeFailed" in report;
      logEvent("PUBLIC_BUILD", { message: `PUBLIC_BUILD ${report.note}` }, { level: failed ? "error" : "log" });
      return { outcome: failed ? "refused" : "ok", reason: report.note };
    },
    { tag: "PUBLIC_BUILD_THREW:", rethrow: false }
  );

  // The meaning index (src/doc-index.ts): documents changed since the last tick go to
  // AI Search, and once a day stale items are removed and missing ones re-sent. A
  // refused upload is recorded as refused; the next edit or the daily pass retries it.
  await runTask(
    env,
    "doc-index",
    () => docIndexTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("DOC_INDEX", { message: `DOC_INDEX ${report.note}` }, { level: report.failed > 0 ? "error" : "log" });
      return { outcome: report.failed > 0 ? "refused" : "ok", reason: report.note };
    },
    { tag: "DOC_INDEX_THREW:", rethrow: false }
  );

  // The daily merge-state sweep. Outcome rows record a pull request as unmerged when
  // written, because the driver blocks and the seat merges afterwards. The merge path
  // corrects the rows it can see; this catches the rest (a merge done with gh rather
  // than capsid_close_pr action merge, and rows written before the join table existed). Bounded per
  // sweep, so the cost is fixed however far behind it is.
  await runTask(
    env,
    "outcome-sweep",
    () => sweepIfDue(env, now),
    (swept): TaskResult => {
      if (!swept) return null;
      const line = `checked ${swept.checked}, changed ${swept.changed}, seeded ${swept.seeded}, backfilled ${swept.backfilled}`;
      logEvent("OUTCOME_SWEEP", { message: `OUTCOME_SWEEP ${line}` });
      return { outcome: "ok", reason: line };
    },
    { tag: "OUTCOME_SWEEP_THREW:", rethrow: false }
  );

  // The site pulse (src/site-pulse.ts): every site's health route, every tick, so a site
  // down on two probes in a row reaches the push step below ten minutes after it fell.
  // Recorded only when a site was called down or came back.
  await runTask(
    env,
    "site-pulse",
    () => sitePulseTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("SITE_PULSE", { message: `SITE_PULSE ${report.note}` }, { level: "error" });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "SITE_PULSE_THREW:", rethrow: false }
  );

  // Phone alerts (src/push.ts): after the auto-merge step and the watcher, so a typed
  // pull request or a rollback they just recorded is seen this tick. It spends no model
  // tokens. Recorded only when an alert was due, so the ledger is not one empty pass
  // every five minutes; no key or no device is not a run.
  await runTask(
    env,
    "push",
    () => pushTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("PUSH", { message: `PUSH ${report.note}` });
      return { outcome: report.sent.length > 0 ? "ok" : "refused", reason: report.note };
    },
    { tag: "PUSH_THREW:", rethrow: false }
  );

  // The daily email digest (src/digest.ts): once a UTC day, and only once Email Routing is
  // on. Off or not due is not a run; a send Cloudflare refused is recorded as refused.
  await runTask(
    env,
    "digest",
    () => digestTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("DIGEST", { message: `DIGEST ${report.note}` }, { level: report.sent ? "log" : "error" });
      return { outcome: report.sent ? "ok" : "refused", reason: report.note };
    },
    { tag: "DIGEST_THREW:", rethrow: false }
  );
}
