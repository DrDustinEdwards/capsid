// The watcher's checks (src/watcher.ts runs the pass): which check owns each
// fingerprint, and which class of finding it is.

// Which check produces each fingerprint. An open finding is cleared only when the check
// that would find it again actually ran: a failed read is not evidence the problem
// went away. A fingerprint no check owns is cleared.
export const WATCHER_CHECKS = [
  "health",
  "master head",
  "migrations",
  "offaccount",
  "offaccount drill",
  "offaccount coverage",
  "ci",
  "site map",
  "repo map",
  "site probes",
  "cloudflare",
  "live checks",
  "site repairs",
  "agent anomalies",
  "domains",
  "deploys",
  "stale canon",
] as const;
export type WatcherCheck = (typeof WATCHER_CHECKS)[number];

const OWNERS: ReadonlyArray<readonly [RegExp, WatcherCheck]> = [
  [/^(health-degraded|backup-stale|backup-never)$/, "health"],
  [/^deploy-drift-/, "master head"],
  [/^schema-behind-/, "migrations"],
  [/^schema-ahead-/, "migrations"],
  [/^offaccount-drill-/, "offaccount drill"],
  [/^offaccount-uncovered-/, "offaccount coverage"],
  [/^offaccount-late-/, "offaccount"],
  [/^offaccount-/, "offaccount"],
  [/^ci-red-/, "ci"],
  [/^site-map-drift-/, "site map"],
  [/^unmapped-repo/, "repo map"],
  [/^site-down-/, "site probes"],
  [/^site-(errors|cpu)-/, "cloudflare"],
  [/^live-config-/, "live checks"],
  [/^live-/, "live checks"],
  [/^site-health-/, "site repairs"],
  [/^site-weekly-/, "site repairs"],
  [/^anomaly-/, "agent anomalies"],
  [/^domain-expiry-/, "domains"],
  [/^deploy-(rolled-back|rollback-failed)-/, "deploys"],
  [/^stale-canon-/, "stale canon"],
];

export function owningCheck(fingerprint: string): WatcherCheck | null {
  return OWNERS.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? null;
}

// WHAT A FINDING IS FOR (every alert actionable, the rest to a digest).
export type FindingClass = "alert" | "digest" | "attention";
const CLASSES: ReadonlyArray<readonly [RegExp, FindingClass]> = [
  [/^(health-degraded|backup-stale|backup-never)$/, "alert"],
  [/^deploy-drift-/, "alert"],
  [/^schema-behind-/, "alert"],
  [/^schema-ahead-/, "digest"],
  [/^offaccount-drill-/, "alert"],
  [/^offaccount-uncovered-/, "alert"],
  [/^offaccount-late-/, "attention"],
  [/^offaccount-/, "alert"],
  [/^ci-red-/, "alert"],
  [/^site-map-drift-/, "alert"],
  [/^unmapped-repo/, "alert"],
  [/^site-down-/, "alert"],
  [/^site-(errors|cpu)-/, "alert"],
  [/^live-config-/, "alert"],
  [/^live-/, "digest"],
  [/^site-health-/, "alert"],
  [/^site-weekly-/, "digest"],
  [/^anomaly-/, "attention"],
  [/^domain-expiry-/, "alert"],
  [/^deploy-(rolled-back|rollback-failed)-/, "alert"],
  [/^stale-canon-/, "digest"],
];

export function findingClass(fingerprint: string): FindingClass {
  return CLASSES.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? "alert";
}

/** The patterns each table names, for the coverage test. */
export const OWNER_PATTERNS: readonly string[] = OWNERS.map(([p]) => p.source);
export const CLASS_PATTERNS: readonly string[] = CLASSES.map(([p]) => p.source);
