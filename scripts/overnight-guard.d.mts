// Types for the overnight guard, so test/overnight-guard.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/overnight-guard.mjs.
export interface Decision {
  decided_by: string;
  decided_on: string;
  ruling: string;
  reasoning: string;
  set_by: string;
  set_at: string;
  reason: string;
}
export interface OvernightState {
  mode: "off" | "api" | "subscription";
  decision: Decision | null;
}
export interface EnvChange {
  set: Record<string, string>;
  unset: string[];
}
export type Verdict = { run: true; runsOn: "api" | "subscription"; env: EnvChange; note: string } | { run: false; why: string };
export interface PlannedJob {
  id: string;
  namespace: string;
  estimate_minutes: number;
  /** A gated job: the session does the ordinary work and lists each risky step in its pull request. */
  gated?: boolean;
}
export interface Lane {
  repo: string;
  namespaces: string[];
  heavy: boolean;
  jobs: PlannedJob[];
  planned_minutes: number;
}
export interface Plan {
  budget_minutes: number;
  lanes: Lane[];
}
export interface LockInfo {
  ns: string;
  pid: number;
  started: string;
}
export type LockResult = { ok: true } | { ok: false; holder: LockInfo | null };

export const PROVIDER_VARS: string[];
export function decideRun(state: OvernightState | null, env: Record<string, string | undefined>): Verdict;
export function childEnv(parent: Record<string, string | undefined>, change: EnvChange): Record<string, string>;
export function laneFor(plan: Plan, ns: string): Lane | null;
export function planPrompt(lane: Lane, budgetMinutes: number): string;
export function acquireHeavyLock(path: string, info: LockInfo, opts?: { now?: () => number; staleMs?: number }): LockResult;
export function releaseHeavyLock(path: string, ns: string): void;
export function waitForHeavyLock(
  path: string,
  info: LockInfo,
  opts: { waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; staleMs?: number }
): Promise<LockResult>;
export function prepareRun(
  client: { tool(name: string, args: object): Promise<string> },
  ns: string,
  env: Record<string, string | undefined>
): Promise<
  | { run: false; why: string; benign: boolean }
  | { run: true; runsOn: "api" | "subscription"; env: EnvChange; note: string; prompt: string; heavy: boolean; budget: number }
>;
