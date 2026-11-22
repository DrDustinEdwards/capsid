import { DAY_MS, utcDay } from "./time";

/** The Monday (UTC) of the week a day falls in, as YYYY-MM-DD. */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return utcDay(new Date(t - dow * DAY_MS));
}

/** The Mondays of the last `weeks` weeks, oldest first, ending with this week's. */
export function weekStarts(now: Date, weeks: number): string[] {
  const thisMonday = Date.parse(`${mondayOf(utcDay(new Date(now.getTime())))}T00:00:00Z`);
  return Array.from({ length: weeks }, (_, i) =>
    utcDay(new Date(thisMonday - (weeks - 1 - i) * 7 * DAY_MS)),
  );
}

/** The last `days` days, oldest first, ending today. */
export function lastDays(now: Date, days: number): string[] {
  const today = Date.parse(`${utcDay(new Date(now.getTime()))}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => utcDay(new Date(today - (days - 1 - i) * DAY_MS)));
}
