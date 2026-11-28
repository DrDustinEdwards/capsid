import type { Env } from "./env";
import { readSiteConfig } from "./ops-sites";
import { readSnapshot } from "./ops-snapshot";
import { readReports } from "./inbox-report";
import { severityOf as worstOf } from "capsomer/behavior/attention-list";

// What an app reports about itself (Carrel's drafts waiting) arrives through POST
// /ops/inbox/report (src/inbox-report.ts), read here as kind "report". A reported item is always
// needs-you: an app may say a person must act, never that its badge should be quieter.

export type { Inbox, InboxApp, InboxItem, InboxSeverity } from "./ops-types/feed";
import type { Inbox, InboxApp, InboxItem, InboxKind, InboxSeverity } from "./ops-types/feed";

const MAX_ITEMS_PER_APP = 50;
const WAITING_ON_PERSON: ReadonlySet<InboxKind> = new Set(["report"]);

export function severityOf(items: readonly Pick<InboxItem, "kind">[]): InboxSeverity {
  return worstOf(items, WAITING_ON_PERSON);
}

export async function gatherInbox(
  env: Env,
  now: Date,
  namespaces: readonly string[] | null,
): Promise<Inbox> {
  const allowed = namespaces === null ? null : new Set(namespaces);
  const keep = (namespace: string) => allowed === null || allowed.has(namespace);
  const byNamespace = new Map<string, InboxItem[]>();
  const add = (namespace: string, item: InboxItem) => {
    if (!keep(namespace)) return;
    const list = byNamespace.get(namespace) ?? [];
    if (list.length < MAX_ITEMS_PER_APP) list.push(item);
    byNamespace.set(namespace, list);
  };

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

  for (const [namespace, items] of await readReports(env.APP_KV, now)) {
    for (const item of items) add(namespace, item);
  }

  // Every configured app appears, with a count of zero when nothing waits, so the shell can draw a
  // quiet badge; a namespace with items but no site row is added after.
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

/**
 * The inbox limited to the apps `readable` admits, with the totals recomputed, so a scoped caller
 * sees its own apps and a count that matches them.
 */
export function restrictInbox(inbox: Inbox, readable: (namespace: string) => boolean): Inbox {
  const apps = inbox.apps.filter((a) => readable(a.namespace));
  const all = apps.flatMap((a) => a.items);
  return { generated: inbox.generated, count: all.length, severity: severityOf(all), apps };
}
