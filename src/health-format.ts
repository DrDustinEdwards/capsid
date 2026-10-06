// THE HEALTH FORMAT every site answers on its health route (docs/health-format.md).
// Capsid defines it so the watcher's sha rule can read every site the same way.

export const HEALTH_STATUSES = ["ok", "degraded", "down"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface ParsedHealth {
  // Null when the body does not carry one of the three statuses.
  status: HealthStatus | null;
  // The deployed commit, or null when the body reports none.
  sha: string | null;
}

const MAX_SHA_CHARS = 40;

/** What a health body says in the standard format. Anything that is not JSON, or a field
 *  that is not the right type, reads as absent: a site that does not report a sha is a
 *  finding for the sha rule, never a crash in the probe. Extra fields are ignored. */
export function parseHealth(body: string | null): ParsedHealth {
  const none: ParsedHealth = { status: null, sha: null };
  if (!body) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return none;
  }
  if (parsed === null || typeof parsed !== "object") return none;
  const { status, sha } = parsed as { status?: unknown; sha?: unknown };
  return {
    status: typeof status === "string" && (HEALTH_STATUSES as readonly string[]).includes(status) ? (status as HealthStatus) : null,
    sha: typeof sha === "string" && sha.length > 0 ? sha.slice(0, MAX_SHA_CHARS) : null,
  };
}
