import type { Env } from "./env";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import { readSiteConfig } from "./ops-sites";
import { readSnapshot } from "./ops-snapshot";
import { prUrlsFromJob } from "./outcome-prs";
import { readReports } from "./inbox-report";

// "WHAT NEEDS DUSTIN, PER APP" (job_84e901d8eb71, Dustin 2026-10-06). The shared admin
// shell shows a badge per app and a combined inbox count; Capsid answers it once, so no
// app queries another. Everything here is read from what the queue, auto-merge and the
// watcher already keep; this module only gathers and counts. It writes nothing.
//
// The app list is configuration (the ops_sites rows the Portal edits), never a list in
// code. A namespace that has something waiting but no site row (Carrel, Capsomer) still
// appears, under its namespace name, because a job waiting on Dustin there is just as
// real.
//
// Severity, per app: needs-you when anything is waiting on a person (a job blocked for
// the seat, a question, a pull request auto-merge declined), failing when only a machine
// fault is open (the latest CI run on the repo failed, the site's health probe is down),
// none otherwise. "Needs you" wins, because it is the thing only Dustin can clear.
//
// What an app reports about itself (Carrel's drafts waiting) arrives through
// POST /ops/inbox/report (src/inbox-report.ts) and is read here as kind "report". A
// reported item is always needs-you: an app may say a person must act, never that its
// badge should be quieter.

// The shapes are in the feed contract (src/ops-types.ts), which the Portal also reads.
export type { Inbox, InboxApp, InboxItem, InboxKind, InboxSeverity } from "./ops-types";
import type { Inbox, InboxApp, InboxItem, InboxKind, InboxSeverity } from "./ops-types";

const MAX_BLOCKED = 200;
const MAX_ITEMS_PER_APP = 50;
const WAITING_ON_PERSON: ReadonlySet<InboxKind> = new Set(["blocked-job", "question", "pr", "report"]);

/** The worst severity of a set of items. */
export function severityOf(items: readonly Pick<InboxItem, "kind">[]): InboxSeverity {
  if (items.some((i) => WAITING_ON_PERSON.has(i.kind))) return "needs-you";
  return items.length > 0 ? "failing" : "none";
}

/** A blocked job as an inbox item. A block that asks a question is marked in its summary
 *  (src/jobs-holder.ts), and it is the kind that most needs a person's words. */
export function blockedJobItem(job: { id: string; title: string; result_ref: string | null; result_summary: string | null; updated_at: string }): InboxItem {
  const question = (job.result_summary ?? "").startsWith("QUESTION:");
  const [pr] = prUrlsFromJob({ result_ref: job.result_ref, result_summary: job.result_summary });
  return { title: job.title, kind: question ? "question" : "blocked-job", link: pr ?? null, since: job.updated_at };
}

/**
 * Gather the inbox for `namespaces` (the ones the caller may read; null means all).
 * `now` stamps the answer.
 */
export async function gatherInbox(env: Env, now: Date, namespaces: readonly string[] | null): Promise<Inbox> {
  const allowed = namespaces === null ? null : new Set(namespaces);
  const keep = (namespace: string) => allowed === null || allowed.has(namespace);
  const byNamespace = new Map<string, InboxItem[]>();
  const add = (namespace: string, item: InboxItem) => {
    if (!keep(namespace)) return;
    const list = byNamespace.get(namespace) ?? [];
    if (list.length < MAX_ITEMS_PER_APP) list.push(item);
    byNamespace.set(namespace, list);
  };

  const blocked = await env.DB.prepare(
    "SELECT id, namespace, title, result_ref, result_summary, updated_at FROM jobs WHERE status = 'blocked' ORDER BY updated_at LIMIT ?1"
  )
    .bind(MAX_BLOCKED)
    .all<{ id: string; namespace: string; title: string; result_ref: string | null; result_summary: string | null; updated_at: string }>();
  for (const job of blocked.results ?? []) add(job.namespace, blockedJobItem(job));

  // The pull requests auto-merge declined, rewritten whole by its tick. An unreadable
  // list reads as none, not as a failure of the inbox.
  try {
    const raw = await env.APP_KV.get(AWAITING_SEAT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const a of parsed as AwaitingSeat[]) {
        // The class says what kind of answer it needs (src/merge-class.ts, report-only).
        const cls = a.class ? ` (${a.class}${a.class_reasons?.[0] ? `: ${a.class_reasons[0].slice(0, 160)}` : ""})` : "";
        add(a.namespace, { title: `PR #${a.number} waits for the seat: ${a.failed}${cls}`, kind: "pr", link: `https://github.com/${a.repo}/pull/${a.number}`, since: a.at });
      }
    }
  } catch {
    // none
  }

  // The watcher's last pass: the newest CI run on each repo and each site's probe.
  const snapshot = await readSnapshot(env).catch(() => null);
  for (const ci of snapshot?.ci ?? []) {
    if (ci.latest?.conclusion === "failure") {
      add(ci.namespace, { title: `CI is failing on ${ci.latest.head_sha.slice(0, 7)}`, kind: "ci", link: ci.latest.url, since: ci.latest.created_at });
    }
  }
  for (const site of snapshot?.sites ?? []) {
    if (site.state === "down") {
      add(site.namespace, { title: `${site.name} is down${site.error ? ` (${site.error})` : ""}`, kind: "site-down", link: site.origin, since: site.checked_at });
    }
  }

  // What each app last reported about itself, while it is under 6 hours old.
  for (const [namespace, items] of await readReports(env.APP_KV, now)) {
    for (const item of items) add(namespace, item);
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
    apps.push({ namespace, name: namespace, count: items.length, severity: severityOf(items), items });
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
