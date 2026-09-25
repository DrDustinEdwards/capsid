// Types for the scorer copier, so test/sync-scorer.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/sync-scorer.mjs.
export const MARKER: string;
export const WORKFLOW: string;
export const REPORT: string;
export function splitBlock(text: string, label: string): { head: string; tail: string };
export function normalize(text: string): string;
export function blockHash(text: string): string;
export function normalizePins(text: string): string;
export function preservePinComments(sourceBlock: string, targetBlock: string): string;
export const SOURCE_ROOT: string;
export function requireCurrent(dir: string, ref: string, label: string): void;
export function remoteHead(dir: string, ref: string, label: string): string;
export function requireRemoteCurrent(dir: string, ref: string, label: string): void;
export function requireLanded(dir: string, ref: string, runs: string, label: string): void;
export function requireWritable(dir: string, ref: string, label: string): void;
export interface SyncTarget {
  dir: string;
  ref: string;
  /** The ref the repo RUNS, when that is not the ref the copier writes. */
  runs?: string;
  label: string;
}
export const TARGETS: SyncTarget[];
export function sync(opts: {
  source: { dir: string; ref: string; label: string };
  targets: SyncTarget[];
  apply: boolean;
  log?: (line: string) => void;
}): number;
