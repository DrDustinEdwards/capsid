import type { Env } from "./env";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import { readSiteConfig } from "./ops-sites";
import { readSnapshot } from "./ops-snapshot";
import { prUrlsFromJob } from "./outcome-prs";
import { readReports } from "./inbox-report";
import { unitInboxItems } from "./merge-units";
import type { MergeClass } from "./merge-class";
import { checkWords } from "./check-words";
import { prsSettled, readStaleCache, type StalePrCache } from "./stale-jobs";
import { readStepCache, stepsSeen, type StaleStepCache } from "./manual-steps";
import { severityOf as worstOf } from "capsomer/behavior/attention-list";
import { plural } from "@drdustinedwards/site-helpers/text";
import { JOB_DOC_PREFIX } from "./jobs-schema";
import { HOUR_MS, MINUTE_MS, timeMs } from "./time";

// "WHAT NEEDS DUSTIN, PER APP". The shared admin shell shows a badge per app and a combined inbox
// count; Capsid answers it once, so no app queries another. Read from what the queue, auto-merge
// and the watcher already keep; this module only gathers and counts, and writes nothing.
//
// The app list is configuration (the ops_sites rows the Portal edits), never code. A namespace
// with something waiting but no site row (Carrel, Capsomer) still appears under its namespace.
//
// Severity, per app: needs-you when anything waits on a person (a job blocked for the seat, a
// question, a pull request auto-merge declined), failing when only a machine fault is open (the
// latest CI run failed, the health probe is down), none otherwise. Needs-you wins.
//
// What an app reports about itself (Carrel's drafts waiting) arrives through POST
// /ops/inbox/report (src/inbox-report.ts), read here as kind "report". A reported item is always
// needs-you: an app may say a person must act, never that its badge should be quieter.

// The shapes are in the feed contract (src/ops-types/), which the Portal also reads.
export type { Inbox, InboxApp, InboxItem, InboxSeverity } from "./ops-types/feed";
import type { Inbox, InboxApp, InboxItem, InboxKind, InboxSeverity } from "./ops-types/feed";

const MAX_BLOCKED = 200;
const MAX_ITEMS_PER_APP = 50;
const WAITING_ON_PERSON: ReadonlySet<InboxKind> = new Set([
  "blocked-job",
  "question",
  "pr",
  "report",
  "proposal",
  "stale-claim",
  "parked-due",
]);

// A claim never expires and nothing releases one on its own (migrations/0044 and 0061: no
// leases). A claimed job whose audit trail has been quiet this long is shown to the seat,
// who decides whether its holder is gone (release) or still working: a notice, never an auto-release. Longer than an overnight run, which can work a job
// for 8 hours without a transition.
export const STALE_CLAIM_MS = 24 * HOUR_MS;
// The tick returns a due parked job within five minutes (src/jobs-park.ts). One still
// parked two ticks after its due date was kept parked, or the tick is not running.
const PARKED_DUE_GRACE_MS = 10 * MINUTE_MS;
const MAX_HELD = 200;

/** A claimed job quiet for STALE_CLAIM_MS, or a parked job past its due date, as an
 *  inbox item; null when neither holds. Its newest activity is the latest of its newest
 *  audit row, its claim and its last change. */
export function heldJobItem(
  job: {
    id: string;
    title: string;
    status: string;
    claimed_by: string | null;
    claimed_at: string | null;
    updated_at: string;
    parked_until: string | null;
    last_audit: string | null;
  },
  now: Date,
): InboxItem | null {
  const nowMs = now.getTime();
  if (job.status === "parked" && job.parked_until) {
    const due = timeMs(job.parked_until);
    if (!Number.isFinite(due) || nowMs - due < PARKED_DUE_GRACE_MS) return null;
    return {
      title: `Due back on ${job.parked_until} but still parked: ${job.title}`,
      kind: "parked-due",
      link: null,
      since: job.parked_until,
      job: job.id,
    };
  }
  if (job.status !== "claimed") return null;
  const times = [job.last_audit, job.claimed_at, job.updated_at]
    .map((t) => timeMs(t))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  const last = Math.max(...times);
  if (nowMs - last < STALE_CLAIM_MS) return null;
  const hours = Math.floor((nowMs - last) / HOUR_MS);
  return {
    title: `Claimed by ${job.claimed_by ?? "(nobody)"} with no activity for ${plural(hours, "hour")}: ${job.title}`,
    kind: "stale-claim",
    link: null,
    since: new Date(last).toISOString(),
    job: job.id,
  };
}

/** The worst severity of a set of items (Capsomer's severityOf, with Capsid's kinds). */
export function severityOf(items: readonly Pick<InboxItem, "kind">[]): InboxSeverity {
  return worstOf(items, WAITING_ON_PERSON);
}

const CLASS_WORDS: Record<MergeClass, string> = {
  auto: "merges on its own",
  approve: "one tap to approve",
  typed: "a typed confirmation",
  seat: "a step outside a merge",
  wait: "nothing yet, CI is running",
};

/** An auto-merge hold as an inbox title, in plain words: what held it, then what it takes.
 *  A visual pull request one tap would merge says it waits for his look, whichever check
 *  stopped it first: a session's visual PR usually names no job, and "names no job" hid
 *  that there was something to look at. */
export function prHoldTitle(
  a: Pick<AwaitingSeat, "number" | "failed" | "class" | "visual">,
): string {
  const why = checkWords(a.visual && a.class === "approve" ? "visual_awaits_look" : a.failed);
  return `PR #${a.number} waits for you: ${why}${a.class ? ` (${CLASS_WORDS[a.class]})` : ""}`;
}

// A blocked job whose block is already answered is not waiting on anyone (for example a migration the
// seat had applied, or a job whose pull requests had merged). Two facts the Worker already holds settle it: every pull request it names is
// merged or closed, as the merge-resume step last read them after the job last changed
// (src/stale-jobs.ts, the same test as the stale view's prs-settled), or every migration
// file its block names (the command is in its summary, src/jobs-holder-block.ts) is in d1_migrations,
// or every manual step its "check:" lines name was seen by the watcher's last pass after the
// job last changed (src/manual-steps.ts, the stale view's steps-seen). Such a job stays
// blocked and shows in the stale view, where it is closed; the inbox leaves it out.
const MIGRATION_FILE = /\b(\d{4}_[a-z0-9_]+)(?:\.sql)?\b/gi;

/** The migration files a blocked job's summary names, without ".sql". */
export function migrationsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(MIGRATION_FILE)].map((m) => m[1]!.toLowerCase()))];
}

export function blockSettled(
  job: { id: string; result_summary: string | null; updated_at: string },
  stale: StalePrCache,
  applied: ReadonlySet<string> | null,
  steps: StaleStepCache = {},
): boolean {
  const entry = stale[job.id];
  if (entry && entry.at >= job.updated_at && prsSettled(entry)) return true;
  const step = steps[job.id];
  if (step && step.at >= job.updated_at && stepsSeen(step)) return true;
  if (!applied) return false;
  const named = migrationsNamed(job.result_summary ?? "");
  return named.length > 0 && named.every((n) => applied.has(n));
}

/** The applied migrations by file name without ".sql", or null when the table cannot be read. */
export async function appliedMigrations(db: D1Database): Promise<Set<string> | null> {
  try {
    const rows = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    return new Set((rows.results ?? []).map((r) => r.name.toLowerCase().replace(/\.sql$/, "")));
  } catch {
    return null;
  }
}

/** A blocked job as an inbox item. A block that asks a question is marked in its summary
 *  (src/jobs-holder-block.ts), and it is the kind that most needs a person's words. */
export function blockedJobItem(job: {
  id: string;
  title: string;
  result_ref: string | null;
  result_summary: string | null;
  updated_at: string;
}): InboxItem {
  const question = (job.result_summary ?? "").startsWith("QUESTION:");
  const [pr] = prUrlsFromJob({ result_ref: job.result_ref, result_summary: job.result_summary });
  return {
    title: job.title,
    kind: question ? "question" : "blocked-job",
    link: pr ?? null,
    since: job.updated_at,
    job: job.id,
  };
}

/**
 * Gather the inbox for `namespaces` (the ones the caller may read; null means all).
 * `now` stamps the answer.
 */
export async function gatherInbox(
  env: Env,
  now: Date,
  namespaces: readonly string[] | null,
): Promise<Inbox> {
  const allowed = namespaces === null ? null : new Set(namespaces);
  const keep = (namespace: string) => allowed === null || allowed.has(namespace);
  const byNamespace = new Map<string, InboxItem[]>();
  // Past MAX_ITEMS_PER_APP an app's items are dropped, so the kinds that name a fault or a
  // waiting pull request are added before the blocked and held jobs, which are the many.
  const dropped = new Map<string, number>();
  const add = (namespace: string, item: InboxItem) => {
    if (!keep(namespace)) return;
    const list = byNamespace.get(namespace) ?? [];
    if (list.length < MAX_ITEMS_PER_APP) list.push(item);
    else dropped.set(namespace, (dropped.get(namespace) ?? 0) + 1);
    byNamespace.set(namespace, list);
  };

  const blocked = await env.DB.prepare(
    "SELECT id, namespace, title, result_ref, result_summary, updated_at FROM jobs WHERE status = 'blocked' ORDER BY updated_at LIMIT ?1",
  )
    .bind(MAX_BLOCKED + 1)
    .all<{
      id: string;
      namespace: string;
      title: string;
      result_ref: string | null;
      result_summary: string | null;
      updated_at: string;
    }>();
  // An unreadable cache or migrations table settles nothing: the job shows, as before.
  // All three are read whether or not a job is blocked, so the feed's stated read count
  // (src/ops-feed.ts, OPS_FEED_READS) does not move with the data.
  const stale = (await readStaleCache(env.APP_KV).catch(() => ({ cache: {} }))).cache;
  const steps = (await readStepCache(env.APP_KV).catch(() => ({ cache: {} }))).cache;
  const applied = await appliedMigrations(env.DB);

  // Claimed jobs gone quiet and parked jobs past their due date (heldJobItem). Both are
  // few, so one read with each job's newest audit row (audit_log_doc serves it).
  const held = await env.DB.prepare(
    `SELECT j.id, j.namespace, j.title, j.status, j.claimed_by, j.claimed_at, j.updated_at, j.parked_until,
            (SELECT MAX(a.at) FROM audit_log a WHERE a.namespace = j.namespace AND a.path = ?1 || j.id || '.md') AS last_audit
       FROM jobs j
      WHERE j.status = 'claimed' OR (j.status = 'parked' AND j.parked_until <= ?2)
      ORDER BY j.updated_at LIMIT ?3`,
  )
    .bind(JOB_DOC_PREFIX, now.toISOString(), MAX_HELD)
    .all<Parameters<typeof heldJobItem>[0] & { namespace: string }>();

  // The pull requests auto-merge declined, rewritten whole by its tick. An unreadable
  // list reads as none, not as a failure of the inbox.
  try {
    const raw = await env.APP_KV.get(AWAITING_SEAT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const a of parsed as AwaitingSeat[]) {
        add(a.namespace, {
          title: prHoldTitle(a),
          kind: "pr",
          link: `https://github.com/${a.repo}/pull/${a.number}`,
          since: a.at,
        });
      }
    }
  } catch {
    // none
  }

  const snapshot = await readSnapshot(env).catch(() => null);
  for (const ci of snapshot?.ci ?? []) {
    if (ci.latest?.conclusion === "failure") {
      add(ci.namespace, {
        title: `CI is failing on ${ci.latest.head_sha.slice(0, 7)}`,
        kind: "ci",
        link: ci.latest.url,
        since: ci.latest.created_at,
      });
    }
  }
  for (const site of snapshot?.sites ?? []) {
    if (site.state === "down") {
      add(site.namespace, {
        title: `${site.name} is down${site.error ? ` (${site.error})` : ""}`,
        kind: "site-down",
        link: site.origin,
        since: site.checked_at,
      });
    }
  }

  // The merge units' proposals and suspensions (src/merge-units.ts): a widening or a
  // narrowing only Dustin signs.
  for (const { namespace, item } of await unitInboxItems(env.APP_KV)) add(namespace, item);

  for (const [namespace, items] of await readReports(env.APP_KV, now)) {
    for (const item of items) add(namespace, item);
  }

  // Claimed and parked jobs, then the blocked ones: the most numerous kinds go last.
  for (const job of held.results ?? []) {
    const item = heldJobItem(job, now);
    if (item) add(job.namespace, item);
  }
  const blockedRows = blocked.results ?? [];
  for (const job of blockedRows.slice(0, MAX_BLOCKED)) {
    if (!blockSettled(job, stale, applied, steps)) add(job.namespace, blockedJobItem(job));
  }
  // The inbox type is the shell's (capsomer), with no field for a cut, so a cut is logged.
  if (dropped.size > 0 || blockedRows.length > MAX_BLOCKED) {
    logEvent("INBOX_TRUNCATED", {
      message: `INBOX_TRUNCATED apps over ${MAX_ITEMS_PER_APP} items: ${JSON.stringify(Object.fromEntries(dropped))}; blocked jobs past ${MAX_BLOCKED}: ${blockedRows.length > MAX_BLOCKED}`,
    });
  }

  // Every configured app appears, with a count of zero when nothing waits, so the shell
  // can draw a quiet badge; a namespace with items but no site row is added after.
  const config = await readSiteConfig(env.DB).catch(() => []);
  const names = new Map<string, string>(config.map((c) => [c.namespace, c.name]));
  const apps: InboxApp[] = [];
  const seen = new Set<string>();
  for (const [namespace, name] of names) {
    if (!keep(namespace)) continue;
    seen.add(namespace);
    const items = byNamespace.get(namespace) ?? [];
    apps.push({ namespace, name, count: items.length, severity: severityOf(items), items });
  }
  for (const [namespace, items] of byNamespace) {
    if (seen.has(namespace)) continue;
    apps.push({
      namespace,
      name: namespace,
      count: items.length,
      severity: severityOf(items),
      items,
    });
  }

  const all = apps.flatMap((a) => a.items);
  return { generated: now.toISOString(), count: all.length, severity: severityOf(all), apps };
}

/** The inbox limited to the apps `readable` admits, with the totals recomputed, so a
 *  scoped caller sees its own apps and a count that matches them. */
export function restrictInbox(inbox: Inbox, readable: (namespace: string) => boolean): Inbox {
  const apps = inbox.apps.filter((a) => readable(a.namespace));
  const all = apps.flatMap((a) => a.items);
  return { generated: inbox.generated, count: all.length, severity: severityOf(all), apps };
}
