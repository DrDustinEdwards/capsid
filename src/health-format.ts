// THE HEALTH FORMAT every site answers on its health route (docs/health-format.md).
// Capsid defines it so the watcher reads every site the same way: the family's
// site-runtime body (status pass, warn or fail, with checks), the older bodies that
// carry only `ok` and `backup.warning`, and Capsid's own ok, degraded or down.

type HealthStatus = "ok" | "degraded" | "down";

const STATUS_OF: Record<string, HealthStatus> = { ok: "ok", degraded: "degraded", down: "down", pass: "ok", warn: "degraded", fail: "down" };

export interface ParsedHealth {
  // Null when the body says nothing about health: no status the format names and no
  // `ok` boolean.
  status: HealthStatus | null;
  // The deployed commit, or null when the body reports none.
  sha: string | null;
  // Why the status is not ok: the failing checks' names and the backup warning. Null
  // when there is nothing to say.
  problem: string | null;
}

const MAX_SHA_CHARS = 40;
const MAX_PROBLEM_CHARS = 200;

/** What a health value says. A field that is not the right type reads as absent: a site
 *  that does not report a sha is a finding for the sha rule, never a crash in the probe.
 *  A backup warning or `ok: false` under an ok status reads as degraded, so a 200 that
 *  admits a problem is not counted as healthy. Extra fields are ignored. */
export function healthOf(value: unknown): ParsedHealth {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: null, sha: null, problem: null };
  const { status, sha, ok, checks, backup } = value as { status?: unknown; sha?: unknown; ok?: unknown; checks?: unknown; backup?: unknown };
  const reasons = failingCheckNames(checks);
  const warning = (backup as { warning?: unknown } | null | undefined)?.warning;
  if (typeof warning === "string" && warning) reasons.push(`backup: ${warning}`);
  let said: HealthStatus | null = typeof status === "string" && Object.hasOwn(STATUS_OF, status) ? STATUS_OF[status]! : null;
  if (said === null && typeof ok === "boolean") said = ok ? "ok" : "degraded";
  if (said === "ok" && (ok === false || reasons.length > 0)) said = "degraded";
  if (said !== null && said !== "ok" && reasons.length === 0 && ok === false) reasons.push("ok: false");
  const problem = said === null || said === "ok" || reasons.length === 0 ? null : reasons.join("; ").slice(0, MAX_PROBLEM_CHARS);
  return { status: said, sha: typeof sha === "string" && sha.length > 0 ? sha.slice(0, MAX_SHA_CHARS) : null, problem };
}

/** healthOf over a body as text. Anything that is not JSON reads as absent. */
export function parseHealth(body: string | null): ParsedHealth {
  if (!body) return healthOf(null);
  try {
    return healthOf(JSON.parse(body));
  } catch {
    return healthOf(null);
  }
}

/** The names of the checks that are not passing: `status` warn or fail in the family
 *  format, `ok === false` in the older one. A check missing both is not failing. */
export function failingCheckNames(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  const out: string[] = [];
  for (const c of checks) {
    if (!c || typeof c !== "object") continue;
    const { name, status, ok } = c as { name?: unknown; status?: unknown; ok?: unknown };
    if (typeof name !== "string") continue;
    if (status === "warn" || status === "fail" || ok === false) out.push(name);
  }
  return out;
}
