// Types for the keep-alive hook script, so tests type-check under tsconfig.test.json.
// The runtime is scripts/lease-keepalive.mjs.
export const THROTTLE_MS: number;
export function findCredentials(start: string): { origin: string; key: string } | null;
export function claimedJobs(statusText: string): Array<{ id: string; namespace: string }>;
export function keepAlive(opts: {
  input: string;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: number;
  stampDir?: string;
}): Promise<{ sent: number; skipped: string | null }>;
