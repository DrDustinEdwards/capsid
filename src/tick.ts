import type { Env } from "./env";
import { mergeResumeTick } from "./merge-resume";
import { returnDueParked } from "./jobs";
import { sweepIfDue } from "./outcome-prs-sweep";
import { offaccountDispatchTick } from "./offaccount-dispatch";
import { runTask, type TaskResult } from "./task-runs";
import { watcherTick } from "./watcher";
import { gatherFindings } from "./watcher-gather";
import { maintenanceTick } from "./maintenance";
import { publicBuildTick } from "./public-data";
import { systemFactsTick } from "./system-facts";
import { docIndexTick } from "./doc-index";
import { pushTick } from "./push";
import { sitePulseTick } from "./site-pulse";
import { type Fetch, signedInCrawlTick } from "./signed-in-crawl";
import { digestTick } from "./digest";
import { logEvent } from "@dustinedwards/site-runtime/log";

// The five-minute tick's steps, in order. Each is its own task in the run ledger (src/task-runs.ts): runTask records a run, and records and logs a throw without rethrowing, so one step's throw does not stop the rest. A step not due returns null from its judge and records nothing.
export async function runTick(env: Env, now: Date, self?: Fetch): Promise<void> {
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
    { tag: "WATCHER_THREW:", rethrow: false },
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
        logEvent(
          "MERGE_RESUME_CACHE",
          { message: `MERGE_RESUME_CACHE ${report.note}` },
          { level: "error" },
        );
        return { outcome: "refused", reason: report.note };
      }
      if (report.resumed.length === 0) return null;
      logEvent("MERGE_RESUME", { message: `MERGE_RESUME ${report.note}` });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "MERGE_RESUME_THREW:", rethrow: false },
  );

  // Parked jobs whose due date passed go back to the queue (src/jobs-park.ts). Recorded
  // only when one was due; a due job kept parked (its title is taken) is a refusal on the
  // ledger, and the inbox shows it until the seat acts.
  await runTask(
    env,
    "park-due",
    () => returnDueParked(env, now),
    (report): TaskResult | null => {
      if (report.returned.length === 0 && report.kept.length === 0) return null;
      logEvent("PARK_DUE", { message: `PARK_DUE ${report.note}` });
      return { outcome: report.kept.length ? "refused" : "ok", reason: report.note };
    },
    { tag: "PARK_DUE_THREW:", rethrow: false },
  );

  // The nightly Amazon copy (capsid-backups' offaccount.yml), started from here when GitHub's
  // schedule has not started it by 11:25 UTC (src/offaccount-dispatch.ts). Not due, or a day
  // that has its run, is not a run.
  await runTask(
    env,
    "offaccount-dispatch",
    () => offaccountDispatchTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent(
        "OFFACCOUNT_DISPATCH",
        { message: `OFFACCOUNT_DISPATCH ${report.note}` },
        { level: report.ok ? "log" : "error" },
      );
      return { outcome: report.ok ? "ok" : "refused", reason: report.note };
    },
    { tag: "OFFACCOUNT_DISPATCH_THREW:", rethrow: false },
  );

  // The daily maintenance pass (src/maintenance.ts): once a UTC day after 11:00, it lists what has
  // gone stale for the seat's morning read.
  await runTask(
    env,
    "maintenance",
    () => maintenanceTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("MAINTENANCE", { message: `MAINTENANCE ${report.note}` });
      return { outcome: "ok", reason: report.note };
    },
    { tag: "MAINTENANCE_THREW:", rethrow: false },
  );

  // The public system model (src/public-data.ts): once a UTC day, repo visibility read from GitHub,
  // the model filtered by toPublic and stored for /public/model/v1.json, and the public repos' code
  // maps for /public/code/v1.json, rebuilt hourly.
  await runTask(
    env,
    "public-build",
    () => publicBuildTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      // A code map that would not parse is a refusal the ledger shows; the model was still built.
      const failed = "codeFailed" in report;
      logEvent(
        "PUBLIC_BUILD",
        { message: `PUBLIC_BUILD ${report.note}` },
        { level: failed ? "error" : "log" },
      );
      return { outcome: failed ? "refused" : "ok", reason: report.note };
    },
    { tag: "PUBLIC_BUILD_THREW:", rethrow: false },
  );

  // The versions and secrets models (src/system-facts.ts): once a UTC day after 06:00, every model repo's package pins and every Worker's secret names and stores, so the 11:00 maintenance pass lists their drift. A half that cannot be read keeps its last good document and is recorded as refused.
  await runTask(
    env,
    "system-facts",
    () => systemFactsTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent(
        "SYSTEM_FACTS",
        { message: `SYSTEM_FACTS ${report.note}` },
        { level: report.failed ? "error" : "log" },
      );
      return { outcome: report.failed ? "refused" : "ok", reason: report.note };
    },
    { tag: "SYSTEM_FACTS_THREW:", rethrow: false },
  );

  // The meaning index (src/doc-index.ts): when documents changed since the last sync
  // started, AI Search is asked to sync from D1. A refused request is recorded as refused
  // and asked again on the next tick.
  await runTask(
    env,
    "doc-index",
    () => docIndexTick(env),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent(
        "DOC_INDEX",
        { message: `DOC_INDEX ${report.note}` },
        { level: report.failed > 0 ? "error" : "log" },
      );
      return { outcome: report.failed > 0 ? "refused" : "ok", reason: report.note };
    },
    { tag: "DOC_INDEX_THREW:", rethrow: false },
  );

  // The daily merge-state sweep. Outcome rows record a pull request as unmerged when written,
  // because the driver blocks and the seat merges afterwards. The merge path corrects the rows it
  // can see; this catches the rest (a merge done with gh, and rows from before the join table
  // existed).
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
    { tag: "OUTCOME_SWEEP_THREW:", rethrow: false },
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
    { tag: "SITE_PULSE_THREW:", rethrow: false },
  );

  // The signed-in crawl (src/signed-in-crawl.ts): hourly, the Portal through this Worker's own handler (`self`),
  // published for devkit's scoreboard. Recorded only when it ran.
  if (self) {
    await runTask(
      env,
      "signed-in-crawl",
      () => signedInCrawlTick(env, now, self),
      (report): TaskResult => (report ? { outcome: "ok", reason: report.note } : null),
      { tag: "SIGNED_IN_CRAWL_THREW:", rethrow: false },
    );
  }

  // Phone alerts (src/push.ts): after the watcher, so a rollback it just recorded is seen this tick. Spends no model tokens. Recorded only when an alert was due; no key or no device is not a run.
  await runTask(
    env,
    "push",
    () => pushTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent("PUSH", { message: `PUSH ${report.note}` });
      return { outcome: report.sent.length > 0 ? "ok" : "refused", reason: report.note };
    },
    { tag: "PUSH_THREW:", rethrow: false },
  );

  // The daily email digest (src/digest.ts): once a UTC day, and only once Email Routing is
  // on. Off or not due is not a run; a send Cloudflare refused is recorded as refused.
  await runTask(
    env,
    "digest",
    () => digestTick(env, now),
    (report): TaskResult => {
      if (!report.ran) return null;
      logEvent(
        "DIGEST",
        { message: `DIGEST ${report.note}` },
        { level: report.sent ? "log" : "error" },
      );
      return { outcome: report.sent ? "ok" : "refused", reason: report.note };
    },
    { tag: "DIGEST_THREW:", rethrow: false },
  );
}
