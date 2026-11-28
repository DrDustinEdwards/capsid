const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const SLOT_MS = 30 * MIN;

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

export function age(t: number, now: number = Date.now()): string {
  return span(Math.max(0, now - t));
}

export function pct(x: number | null, dp = 2): string {
  return x == null ? "-" : `${(x * 100).toFixed(dp)}%`;
}

export function shortId(id: string | null, n = 8): string {
  return id ? id.slice(0, n) : "";
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
