export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const SLOT_MS = 30 * MIN;

// A server timestamp with no zone: D1's datetime('now') ("YYYY-MM-DD HH:MM:SS") or the
// same with a T. Date.parse reads either as the browser's local time, which behind UTC
// puts a row hours in the future, so it is read as UTC here.
const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

// Milliseconds from a server timestamp. The feed sends ISO with a zone; one without is
// UTC, because every timestamp the Worker writes is.
export function ms(iso: string): number {
  return Date.parse(ZONELESS.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
}

// The Portal's "now" for relative times: the browser's clock moved onto the server's by
// the skew measured when the feed arrived, and never earlier than the newest time a
// server read reported. Otherwise a row written after the app's last tick, or on a
// server whose clock runs ahead of the browser's, reads "in 16s".
export function portalNow(clientNow: number, skew: number, newestServerRead: number): number {
  return Math.max(clientNow + skew, newestServerRead);
}

// Milliseconds from a D1 datetime('now') value ("2026-09-28 11:00:00", UTC with no zone
// mark), which Date.parse would read as local time. An ISO string passes through.
export function msSql(t: string): number {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t) ? Date.parse(`${t.replace(" ", "T")}Z`) : Date.parse(t);
}

function span(a: number): string {
  if (a < MIN) return `${Math.round(a / 1000)}s`;
  if (a < HOUR) return `${Math.round(a / MIN)}m`;
  if (a < 2 * DAY) return `${(a / HOUR).toFixed(a < 10 * HOUR ? 1 : 0)}h`;
  return `${(a / DAY).toFixed(1)}d`;
}

export function ago(t: number, now: number = Date.now()): string {
  const d = now - t;
  const s = span(Math.abs(d));
  return d >= 0 ? `${s} ago` : `in ${s}`;
}

// "3.2h", no "ago": for "waiting 3.2h" and "oldest 2.1d".
export function age(t: number, now: number = Date.now()): string {
  return span(Math.max(0, now - t));
}

export function utc(t: number): string {
  return `${new Date(t).toISOString().replace("T", " ").slice(0, 16)}Z`;
}

// An exact time for a panel or a detail field (ruled 2026-09-30, DECIDE 13): the
// viewer's own zone, named, with UTC beside it, and the ISO form for a <time> element.
// Rows keep relative times only.
const LOCAL = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

export function exactTime(t: number): { iso: string; local: string; utc: string } {
  if (!Number.isFinite(t)) return { iso: "", local: "an unreadable time", utc: "" };
  return { iso: new Date(t).toISOString(), local: LOCAL.format(t), utc: utc(t).replace("Z", " UTC") };
}

export function pct(x: number | null, dp = 2): string {
  return x == null ? "-" : `${(x * 100).toFixed(dp)}%`;
}

// A byte count in binary units, as D1's limits are stated: "12.3 MB", "10 GB".
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtN(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function shortId(id: string | null, n = 8): string {
  return id ? id.slice(0, n) : "";
}

// An agent as a row names it. A seat-started runner's name carries its job's id
// (`runner-<job>-s<n>`, src/runner-key.ts), so a row calls it a runner; the full name is
// in the drawer (design D11).
export function agentLabel(agent: string): string {
  return /^(agent:)?runner-job_/.test(agent) ? "a seat-started runner" : agent;
}

export function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    // Not a URL: show what the feed sent rather than nothing.
    return origin;
  }
}
