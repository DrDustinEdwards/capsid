// The watcher's checks (src/watcher.ts runs the pass): which check owns each
// fingerprint, and which class of finding it is.

// Which check produces each fingerprint. An open job is cleared only when the check
// that would find it again actually ran: a failed read is not evidence the problem
// went away. A fingerprint no check owns is cleared.
export const WATCHER_CHECKS = [
  "health",
  "master head",
  "migrations",
  "status",
  "mirror dumps",
  "mirror runs",
  "ci",
  "site map",
  "repo map",
  "site probes",
  "cloudflare",
  "live checks",
  "site repairs",
  "agent anomalies",
  "tool anomalies",
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
  [/^breaker-open-/, "status"],
  [/^mirror-no-dump$/, "mirror dumps"],
  [/^(mirror-not-running$|mirror-run-failed-|mirror-green-no-dump$)/, "mirror runs"],
  [/^ci-red-/, "ci"],
  [/^site-map-drift-/, "site map"],
  [/^unmapped-repo/, "repo map"],
  [/^site-down-/, "site probes"],
  [/^site-(errors|cpu)-/, "cloudflare"],
  [/^live-config-/, "live checks"],
  [/^live-/, "live checks"],
  [/^site-health-/, "site repairs"],
  [/^site-weekly-/, "site repairs"],
  // Before the audit rule's prefix, which would otherwise claim these too.
  [/^anomaly-tool-/, "tool anomalies"],
  [/^anomaly-/, "agent anomalies"],
  [/^domain-expiry-/, "domains"],
  [/^deploy-(rolled-back|rollback-failed)-/, "deploys"],
  [/^stale-canon-/, "stale canon"],
];

export function owningCheck(fingerprint: string): WatcherCheck | null {
  return OWNERS.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? null;
}

// WHAT A FINDING IS FOR (job_2c92174d5bff item 5; every alert actionable, the rest to a
// digest). One class per OWNERS pattern, the same patterns in the same order:
//   job        a person must act now: it posts a job.
//   digest     a hygiene or drift finding: kept in finding memory and shown on the Portal's
//              weekly digest per site and in the Monday email; posts no job.
//   attention  shown on the Portal's attention list only; posts no job.
// test/watcher-classes.test.ts fails when OWNERS and this table disagree in either
// direction. A fingerprint no pattern names is a job, so an unclassed finding is loud.
export type FindingClass = "job" | "digest" | "attention";
const CLASSES: ReadonlyArray<readonly [RegExp, FindingClass]> = [
  [/^(health-degraded|backup-stale|backup-never)$/, "job"],
  [/^deploy-drift-/, "job"],
  [/^schema-behind-/, "job"],
  [/^schema-ahead-/, "digest"],
  [/^breaker-open-/, "attention"],
  [/^mirror-no-dump$/, "job"],
  [/^(mirror-not-running$|mirror-run-failed-|mirror-green-no-dump$)/, "job"],
  [/^ci-red-/, "job"],
  [/^site-map-drift-/, "job"],
  [/^unmapped-repo/, "job"],
  [/^site-down-/, "job"],
  [/^site-(errors|cpu)-/, "job"],
  [/^live-config-/, "job"],
  [/^live-/, "digest"],
  [/^site-health-/, "job"],
  [/^site-weekly-/, "digest"],
  [/^anomaly-tool-/, "attention"],
  [/^anomaly-/, "attention"],
  [/^domain-expiry-/, "job"],
  [/^deploy-(rolled-back|rollback-failed)-/, "job"],
  [/^stale-canon-/, "digest"],
];

export function findingClass(fingerprint: string): FindingClass {
  return CLASSES.find(([pattern]) => pattern.test(fingerprint))?.[1] ?? "job";
}

/** The patterns each table names, for the coverage test. */
export const OWNER_PATTERNS: readonly string[] = OWNERS.map(([p]) => p.source);
export const CLASS_PATTERNS: readonly string[] = CLASSES.map(([p]) => p.source);
