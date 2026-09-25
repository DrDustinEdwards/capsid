import { bytesToHex } from "./encoding";
import { SCOPE_FLAGS, type ScopeFlag } from "./agents-schema";
import type { Agent } from "./agents";
import { checkScope } from "./scope";

// The work queue's vocabulary, in one place so the table, the tool and the driver
// cannot disagree about it.

export const JOB_STATUSES = ["queued", "claimed", "done", "failed", "blocked", "superseded"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// The states a job still holds a title slot in. The partial unique index names the
// same values, and test/jobs.test.ts asserts they agree with the last migration that
// defines it. Blocked is open: it is a pause, and resume takes the row back to claimed.
export const OPEN_JOB_STATUSES: readonly JobStatus[] = ["queued", "claimed", "blocked"];

// The finished states. A job's mirror document closes on these. Superseded is finished
// but not a failure (migrations/0020): the job was replaced before any work was done,
// so it writes no outcome row.
const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "superseded"];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export const JOB_ACTIONS = ["post", "list", "claim", "heartbeat", "complete", "fail", "block", "resume", "supersede"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

// Four hours. The driver heartbeats every 15 minutes, so the lease is the backstop for
// a session that died, not the renewal path.
export const JOB_LEASE_SECONDS = 4 * 60 * 60;

export const JOBS_ROWS_MAX = 100;

// Every job is also a document, so brief and search see the queue. The table is the
// source of truth for status.
export const jobDocPath = (id: string) => `jobs/${id}.md`;

export interface JobRow {
  id: string;
  namespace: string;
  title: string;
  body: string;
  priority: number;
  status: JobStatus;
  posted_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires: string | null;
  result_ref: string | null;
  result_summary: string | null;
  gate_required: number;
  // The scopes this job's work needs of the driver that claims it, as JSON, or null
  // for the jobs that need nothing unusual (migrations/0009).
  required_scopes: string | null;
  // The track record this job needs of that driver, as JSON, or null (migrations/0011).
  min_record: string | null;
  // Gates hit and human resumes, counted where they happen (migrations/0007).
  blocked_count: number;
  resumed_count: number;
  // The retry cap's budget (migrations/0016): only the times the work was sent back to
  // be corrected. See atCorrectionCap.
  corrections_count: number;
  // 1 when a reviewer must speak before the work reaches the seat (migrations/0017).
  // On the row, so the party being reviewed does not decide whether it is reviewed.
  review_required: number;
  created_at: string;
  updated_at: string;
}

// The retry cap: two corrections, then a human. Each round is defensible on its own,
// which is why the ceiling is counted rather than judged.

export const CORRECTION_CAP = 2;

export const RETRY_CAP_REASON = "retry cap; human decision required";

/** Whether a job has spent its correction budget. Fails closed: a count that is not a
 *  finite number at or above zero is treated as at the cap. */
export function atCorrectionCap(corrections: number): boolean {
  if (!Number.isFinite(corrections) || corrections < 0) return true;
  return corrections >= CORRECTION_CAP;
}

/** A capped job's summary: the cap, then the driver's own summary, which the human
 *  deciding needs to read. */
export function cappedSummary(summary: string | null): string {
  const said = summary?.trim();
  return said ? `${RETRY_CAP_REASON}\n\n${said}` : RETRY_CAP_REASON;
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

// The scopes a job's work requires (migrations/0009), checked by the same function as
// an agent's scopes. Flags only: the write grant and the namespace are required of
// every claim already, so a job has only blast radius left to declare.
export interface RequiredScopes {
  flags: ScopeFlag[];
}

// A requirement that cannot be read is corrupt, not absent: a garbled "needs
// can_merge" is not "needs nothing". post validates both fields, so an unreadable
// value comes from a write that bypassed post. The claim marks such a job failed;
// resume refuses and leaves it blocked. null, undefined, "" and an object without the
// field are no requirement.
export type ParsedRequirement<T> = { ok: true; value: T } | { ok: false; problem: string };

function parseObject(field: string, json: string): ParsedRequirement<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, problem: `${field} is not JSON` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: `${field} is not a JSON object` };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

export function parseRequiredScopes(json: string | null | undefined): ParsedRequirement<RequiredScopes> {
  if (!json) return { ok: true, value: { flags: [] } };
  const parsed = parseObject("required_scopes", json);
  if (!parsed.ok) return parsed;
  const flags = parsed.value.flags;
  if (flags === undefined) return { ok: true, value: { flags: [] } };
  if (!Array.isArray(flags)) return { ok: false, problem: "required_scopes.flags is not an array" };
  const unknown = flags.filter((f) => !(SCOPE_FLAGS as readonly unknown[]).includes(f));
  if (unknown.length) {
    const names = unknown.map((f) => JSON.stringify(f)).join(", ");
    return { ok: false, problem: `required_scopes.flags names ${names}, which ${unknown.length === 1 ? "is not a flag" : "are not flags"}` };
  }
  return { ok: true, value: { flags: flags as ScopeFlag[] } };
}

/** The problem with a job's stored requirements, or null when both read cleanly. */
export function corruptRequirement(job: { required_scopes: string | null; min_record: string | null }): string | null {
  const scopes = parseRequiredScopes(job.required_scopes);
  if (!scopes.ok) return scopes.problem;
  const min = parseMinRecord(job.min_record);
  return min.ok ? null : min.problem;
}

export function serializeRequiredScopes(required: Partial<RequiredScopes>): string {
  return JSON.stringify({ flags: required.flags ?? [] });
}

// The claim's authorization, through the one enforcement point: the write grant and
// the namespace for every job, plus the job's own flags. Returns a refusal or null.
export function missingForJob(agent: Agent, namespace: string, requiredScopes: string | null | undefined): string | null {
  const required = parseRequiredScopes(requiredScopes);
  // Fails closed for a caller that skipped the claim's corrupt check.
  if (!required.ok) return `this job's ${required.problem}, so nothing can be checked against it.`;
  return checkScope(agent, { tool: "jobs", namespace, grant: "write", flags: required.value.flags });
}

/** The namespace half of missingForJob, for a resume that returns a job to its own
 *  claimant: the caller acquires nothing but still moves the job. */
export function outsideJobNamespace(agent: Agent, namespace: string): string | null {
  return checkScope(agent, { tool: "jobs", namespace, grant: "write" });
}

// job_<12 hex>, random rather than sequential so an id quoted in chat cannot be used
// to address a job by arithmetic. The PRIMARY KEY refuses a collision.
// Hex through bytesToHex (src/encoding.ts).
export function mintJobId(): string {
  return `job_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
}

// What a job needs of the driver's history (migrations/0011): a scope says what a
// credential may do, this says what it has done. Each bar must be a number the agent
// record computes and the console shows. No rate bar: a rate over a small
// denominator is noise.
export interface MinRecord {
  prs_merged?: number;
}

// Fails closed, as parseRequiredScopes does.
export function parseMinRecord(json: string | null | undefined): ParsedRequirement<MinRecord> {
  if (!json) return { ok: true, value: {} };
  const parsed = parseObject("min_record", json);
  if (!parsed.ok) return parsed;
  const value = parsed.value.prs_merged;
  if (value === undefined) return { ok: true, value: {} };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, problem: `min_record.prs_merged is ${JSON.stringify(value)}, not a whole number of zero or more` };
  }
  return { ok: true, value: { prs_merged: value } };
}

export function serializeMinRecord(min: MinRecord): string {
  return JSON.stringify({ prs_merged: min.prs_merged ?? 0 });
}

// The bar against the record's numbers, a pure comparison; src/agent-record.ts
// computes them. Returns a refusal naming the shortfall, or null.
export function missingForRecord(record: { prs_merged: number }, minRecord: string | null | undefined): string | null {
  const parsed = parseMinRecord(minRecord);
  if (!parsed.ok) return `this job's ${parsed.problem}, so no record can be compared against it.`;
  const { prs_merged } = parsed.value;
  if (prs_merged === undefined || record.prs_merged >= prs_merged) return null;
  return `this job asks for a driver with at least ${prs_merged} merged pull request${prs_merged === 1 ? "" : "s"} on its record, and this one has ${record.prs_merged}.`;
}

// A swallowed parameter tag: a caller that closes a parameter tag inside a value sends
// the later arguments as literal text in that value. Refused rather than cleaned up,
// because the lost arguments cannot be recovered from the text, and the outcome row
// cannot be corrected after the write. test/jobs.test.ts derives these names from
// the tool's schema.
export const JOB_PARAM_NAMES = [
  "action",
  "namespace",
  "title",
  "body",
  "id",
  "result_summary",
  "result_ref",
  "reason",
  "replaced_by",
  "command",
  "evidence",
] as const;

// Only the full `</name>` spelling, so a body that discusses this rule is not refused.
const SWALLOWED_TAG = new RegExp(`</(${JOB_PARAM_NAMES.join("|")})>`);

// The first parameter name found, which is where the value was cut off, or null.
export function swallowedParamTag(value: string): string | null {
  const match = SWALLOWED_TAG.exec(value ?? "");
  return match ? match[1] : null;
}

// One message for every call site. It names both the field and the tag, because a
// value cut off by its own closing tag reads confusingly unless both are stated.
export function swallowedTagRefusal(field: string, tag: string): string {
  const own = field === tag ? " (its own closing tag)" : "";
  return (
    `${field} contains the literal text '</${tag}>'${own}. That means a parameter tag was closed inside a value, ` +
    `so '${tag}' and everything after it were swallowed into ${field} rather than arriving as their own arguments. ` +
    `Nothing was written. Re-send the call with each parameter as a separate argument.`
  );
}
