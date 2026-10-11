// Types for the all-sites drill, so test/drill-all.test.ts type-checks under
// tsconfig.test.json. The runtime is scripts/drill-all.mjs.
import type { R2Like } from "@dustinedwards/d1-dump";

export interface Site {
  name: string;
  bucket: string;
}
export interface DrillRun {
  code: number;
  output: string;
}
export const SITES: Site[];
export function runDrillCli(dir: string, prefix: string): DrillRun;
export function firstFailure(output: string): string;
export function drillSite(
  site: string,
  bucket: R2Like,
  opts?: { now?: Date; runDrill?: (dir: string, prefix: string) => DrillRun | Promise<DrillRun> },
): Promise<{ line: string; ok: boolean }>;
export function selectSites(argv: string[], sites?: Site[]): Site[];
export function main(argv?: string[]): Promise<number>;
