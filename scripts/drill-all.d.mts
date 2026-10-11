// Types for the all-sites drill, so test/drill-all.test.ts type-checks under
// tsconfig.test.json. The runtime is scripts/drill-all.mjs.
import type { R2Like } from "@dustinedwards/d1-dump";

export interface Site {
  name: string;
  bucket: string;
  /** The site has no FTS5 table: d1-dump's `search` check is reported n/a, not FAIL. */
  noSearch?: boolean;
}
export interface DrillRun {
  code: number;
  output: string;
}
export const SITES: Site[];
export function runDrillCli(dir: string, prefix: string): DrillRun;
export function firstFailure(output: string): string;
export function onlySearchUnavailable(output: string): boolean;
export function drillSite(
  site: string,
  bucket: R2Like,
  opts?: { now?: Date; runDrill?: (dir: string, prefix: string) => DrillRun | Promise<DrillRun>; noSearch?: boolean },
): Promise<{ line: string; ok: boolean }>;
export function selectSites(argv: string[], sites?: Site[]): Site[];
export function main(argv?: string[]): Promise<number>;
