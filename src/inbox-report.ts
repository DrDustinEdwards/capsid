import { checkScope } from "./scope";
import type { Agent } from "./agents";
import type { InboxItem } from "./inbox";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// - The key must hold the write grant on the namespace the report names, through checkScope (one
// enforcement point, test/scope.test.ts); - A report replaces the last one whole and expires after
// 6 hours: a stale "needs you" is worse than none.

const INBOX_REPORT_PATH = "/ops/inbox/report";
const REPORT_PREFIX = "inbox:report:";
const REPORT_RATE_PREFIX = "inbox:report-rate:";
export const REPORT_TTL_SECONDS = 6 * 3600;
const REPORT_RATE_SECONDS = 60;
export const MAX_REPORT_ITEMS = 20;
export const MAX_REPORT_TITLE = 200;
export const MAX_INBOX_REPORT_BYTES = 16384;

export interface StoredReport {
  namespace: string;
  reported_at: string;
  reported_by: string;
  items: InboxItem[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; refusal: string };

const ITEM_KEYS = new Set(["title", "link", "since"]);
const BODY_KEYS = new Set(["namespace", "items"]);

/**
 * The report a body describes, or why it is refused. `origin` is the namespace's site origin or
 * null when it serves no site (then no item may carry a link). Anything outside the contract
 * refuses the whole report, so a half-read report is never stored.
 */
export function parseReport(
  body: unknown,
  origin: string | null,
  now: Date,
): Checked<{ namespace: string; items: InboxItem[] }> {
  const refuse = (refusal: string): Checked<never> => ({ ok: false, refusal });
  if (!body || typeof body !== "object" || Array.isArray(body))
    return refuse("the body must be a JSON object { namespace, items }");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!BODY_KEYS.has(key))
      return refuse(
        `unknown field '${key}': a report has namespace and items only (no severity: a reported item always counts as needs-you)`,
      );
  if (typeof record.namespace !== "string" || record.namespace === "")
    return refuse("namespace is required");
  if (!Array.isArray(record.items))
    return refuse("items must be an array (send [] to clear the app's report)");
  if (record.items.length > MAX_REPORT_ITEMS)
    return refuse(`at most ${MAX_REPORT_ITEMS} items; got ${record.items.length}`);
  const items: InboxItem[] = [];
  for (const [i, raw] of record.items.entries()) {
    const at = `item ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return refuse(`${at} must be an object { title, link?, since? }`);
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item))
      if (!ITEM_KEYS.has(key)) return refuse(`${at} has unknown field '${key}'`);
    if (typeof item.title !== "string" || item.title.trim() === "")
      return refuse(`${at} needs a title`);
    if (item.title.length > MAX_REPORT_TITLE)
      return refuse(`${at}'s title is over ${MAX_REPORT_TITLE} characters`);
    let link: string | null = null;
    if (item.link !== undefined && item.link !== null) {
      if (typeof item.link !== "string") return refuse(`${at}'s link must be a string`);
      const own = linkRefusal(item.link, origin);
      if (own) return refuse(`${at}: ${own}`);
      link = item.link;
    }
    let since = now.toISOString();
    if (item.since !== undefined) {
      const parsed = typeof item.since === "string" ? Date.parse(item.since) : NaN;
      if (!Number.isFinite(parsed)) return refuse(`${at}'s since must be an ISO time`);
      since = new Date(parsed).toISOString();
    }
    items.push({ title: item.title.trim(), kind: "report", link, since });
  }
  return { ok: true, value: { namespace: record.namespace, items } };
}

function linkRefusal(link: string, origin: string | null): string | null {
  if (origin === null)
    return "this namespace serves no site, so its report items may not carry a link";
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return `link '${link}' is not a URL`;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== origin)
    return `link must be an https URL on the app's own origin ${origin}`;
  return null;
}

export function reportCallerRefusal(agent: Agent, namespace: string): string | null {
  return checkScope(agent, { tool: INBOX_REPORT_PATH, grant: "write", namespace });
}

/**
 * Spend the key's one report this minute, or say why not. Fails closed: a counter that cannot be
 * read or written refuses, because an unbounded write path is the thing the limit exists to stop.
 */
export async function spendReportRate(
  kv: KVNamespace,
  actor: string,
): Promise<{ ok: true } | { ok: false; status: 429 | 503; refusal: string }> {
  const key = `${REPORT_RATE_PREFIX}${actor}`;
  try {
    if ((await kv.get(key)) !== null)
      return {
        ok: false,
        status: 429,
        refusal: `one report per minute per key; ${actor} already reported this minute`,
      };
    await kv.put(key, "1", { expirationTtl: REPORT_RATE_SECONDS });
  } catch (err) {
    return {
      ok: false,
      status: 503,
      refusal: `the report rate limit could not be read, so the report is refused: ${errorMessage(err)}`,
    };
  }
  return { ok: true };
}

export async function storeReport(kv: KVNamespace, report: StoredReport): Promise<void> {
  await kv.put(`${REPORT_PREFIX}${report.namespace}`, JSON.stringify(report), {
    expirationTtl: REPORT_TTL_SECONDS,
  });
}

export function reportItems(raw: string | null, now: Date): InboxItem[] {
  if (!raw) return [];
  let parsed: Partial<StoredReport>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredReport>;
  } catch {
    return [];
  }
  const at = Date.parse(parsed.reported_at ?? "");
  if (!Number.isFinite(at) || now.getTime() - at > REPORT_TTL_SECONDS * 1000) return [];
  return Array.isArray(parsed.items)
    ? parsed.items.filter((i) => i && i.kind === "report" && typeof i.title === "string")
    : [];
}

export async function readReports(kv: KVNamespace, now: Date): Promise<Map<string, InboxItem[]>> {
  const out = new Map<string, InboxItem[]>();
  try {
    const listed = await kv.list({ prefix: REPORT_PREFIX });
    for (const { name } of listed.keys) {
      const items = reportItems(await kv.get(name), now);
      if (items.length) out.set(name.slice(REPORT_PREFIX.length), items);
    }
  } catch {
    // none: the shell renders without what it cannot read
  }
  return out;
}
