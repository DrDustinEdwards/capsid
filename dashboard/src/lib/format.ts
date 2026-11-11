import { MIN } from "capsomer/behavior/time";

// Times (parsing a server timestamp, relative and exact forms, the server's now) are Capsomer's
// capsomer/behavior/time; these are the Portal's other formats.

export const SLOT_MS = 30 * MIN;

export function pct(x: number | null, dp = 2): string {
  return x == null ? "-" : `${(x * 100).toFixed(dp)}%`;
}

// A byte count in binary units, as D1's limits are stated: "12.3 MB", "10 GB".
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function fmtN(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function shortId(id: string | null, n = 8): string {
  return id ? id.slice(0, n) : "";
}

// An agent as a row names it. A runner key from the retired seat start carries its job's id
// (`runner-<job>-s<n>`), so a row calls it a runner; the full name is
// in the drawer (design D11).
export function agentLabel(agent: string): string {
  return /^(agent:)?runner-job_/.test(agent) ? "a seat-started runner" : agent;
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    // Not a URL: show what the feed sent rather than nothing.
    return origin;
  }
}
