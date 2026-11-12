// Time units in milliseconds, one spelling for the whole Worker.
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The UTC calendar day of a date, as YYYY-MM-DD. */
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** A span in days to one decimal: "2.5 days". */
export const days = (ms: number): string => `${(ms / DAY_MS).toFixed(1)} days`;

/** "2026-W40": the ISO 8601 week `d` falls in. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
