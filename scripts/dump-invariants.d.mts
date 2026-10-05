// Types for the dump invariants, so test/dump-invariants.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/dump-invariants.mjs.
export const COMPLETE_MARKER: string;
export const SIDECARS: string[];
export const OPTIONAL_SIDECARS: string[];
export interface DumpSummary {
  files: number;
  tables: number;
  rows: number;
  documents: number;
  orphanVersions: number;
  orphanAudits: number;
}
export function checkDump(dumpDir: string): DumpSummary;
