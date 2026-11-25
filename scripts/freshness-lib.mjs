// The backup freshness check (gate 1c), apart from the gate so a test can drive it (verify-live.mjs runs on import).
// 26 hours is the daily cron plus two hours' grace, the same as src/health.ts. Asserted on scheduled runs only (a push says nothing about last night's backup); a skip is reported as a skip, never a pass.
// The age is computed here from last_ok, not taken from the response's age_hours: a number the thing under test reports is not a measurement of it. A large disagreement is itself a finding, a clock mismatch.

export const BACKUP_STALE_HOURS = 26;

// Beyond this, the computed and reported ages come from different clocks; well above any request latency.
const CLOCK_SKEW_TOLERANCE_HOURS = 1;

/**
 * @param {unknown} health the parsed /health body
 * @param {{ assert: boolean, now?: number, maxHours?: number }} opts
 * @returns {{ outcome: "fresh"|"stale"|"unknown"|"skipped", passed: boolean, detail: string }}
 */
export function checkBackupFreshness(health, opts) {
  const maxHours = opts.maxHours ?? BACKUP_STALE_HOURS;
  const backup = health && typeof health === "object" ? health.backup : null;
  const lastOk = backup && typeof backup === "object" ? backup.last_ok : null;

  if (!opts.assert) {
    const seen = typeof lastOk === "string" ? lastOk : "(none)";
    return {
      outcome: "skipped",
      passed: true,
      detail: `SKIPPED: freshness is asserted on scheduled runs only (last_ok=${seen}). This run asserts nothing about it.`,
    };
  }

  if (typeof lastOk !== "string" || lastOk.length === 0) {
    // Fail closed: no stamp means no clean backup, the condition this gate exists to catch.
    return {
      outcome: "unknown",
      passed: false,
      detail: `no backup:last-ok is recorded, so no clean backup has completed. /health reported backup=${JSON.stringify(backup)}`,
    };
  }

  const stamped = Date.parse(lastOk);
  if (Number.isNaN(stamped)) {
    return {
      outcome: "unknown",
      passed: false,
      detail: `backup.last_ok is not a parseable timestamp: ${JSON.stringify(lastOk)}`,
    };
  }

  const now = opts.now ?? Date.now();
  const ageHours = Math.round(((now - stamped) / 3_600_000) * 10) / 10;
  const reported = typeof backup.age_hours === "number" ? backup.age_hours : null;
  const skew =
    reported === null
      ? ""
      : ` (worker reported ${reported}h${Math.abs(reported - ageHours) > CLOCK_SKEW_TOLERANCE_HOURS ? ", DISAGREEING with this runner's clock" : ""})`;

  // A future stamp (negative age) beyond the clock skew tolerance is a bad stamp or clock and proves nothing.
  if (ageHours < -CLOCK_SKEW_TOLERANCE_HOURS) {
    return {
      outcome: "unknown",
      passed: false,
      detail: `backup.last_ok is ${-ageHours}h in the future of this runner's clock, past the ${CLOCK_SKEW_TOLERANCE_HOURS}h skew tolerance${skew}. last_ok=${lastOk}`,
    };
  }
  if (ageHours > maxHours) {
    return {
      outcome: "stale",
      passed: false,
      detail: `the last clean backup was ${ageHours}h ago, over the ${maxHours}h threshold${skew}. last_ok=${lastOk}`,
    };
  }
  return {
    outcome: "fresh",
    passed: true,
    detail: `last clean backup ${ageHours}h ago${skew}, under the ${maxHours}h threshold`,
  };
}
