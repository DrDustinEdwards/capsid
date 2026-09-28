export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const SLOT_MS = 30 * MIN;

// Milliseconds from an ISO string. The contract's timestamps are all ISO.
export function ms(iso: string): number {
  return Date.parse(iso);
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

export function pct(x: number | null, dp = 2): string {
  return x == null ? "-" : `${(x * 100).toFixed(dp)}%`;
}

export function fmtN(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function shortId(id: string | null, n = 8): string {
  return id ? id.slice(0, n) : "";
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
