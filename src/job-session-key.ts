import type { Agent } from "./agents";
import { mintAgentId, mintAgentKey, serializeScopes } from "./agents-schema";
import { sha256Hex } from "./auth";

// PER-JOB KEYS FOR UNATTENDED DRIVERS (OWASP agentic hardening item 5, ASI03;
// capsid/research/design-owasp-hardening.md; Dustin's D1 of 2026-10-03: option (a), for
// scheduled drivers only, and interactive tabs keep their long-lived key and scopes).
//
// A Claude Code session's MCP credential is fixed when it starts, so a key minted by a
// claim made inside a session cannot become that session's credential. The scheduler
// (scripts/schedule-drivers.mjs) therefore claims BEFORE it launches, with the driver's
// long-lived key and `session_key: true`. The claim runs every check as the driver (its
// limit, its repo, its flags, its record), then hands the job to a key minted for it in
// the same batch: kind session, bound to the job through agents.job_id like a runner key
// (src/runner-key.ts), holding the driver's own scopes and a claim limit of one. The
// session is launched with that key alone. It resolves only while it holds the job under
// a live lease (boundJobLive, src/agents.ts), may make no jobs call on another job
// (src/scope.ts), and is revoked by complete, fail and block like a runner key.
//
// The key's name is `<driver>@<job id>.<6 hex>`: '@' is refused in every name a person
// mints (src/agents-admin.ts), so the prefix is proof of the driver it was minted for,
// and the driver's held claims count the jobs its keys hold (heldClaims).

export const SESSION_KEY_SEPARATOR = "@";

export interface SessionKey {
  name: string;
  key: string;
  fingerprint: string;
  note: string;
  statements: D1PreparedStatement[];
}

/** Why this caller may not hand a claim to a session key, or null. A minted driver
 *  only: not the admin, a legacy key, a seat or a key that is itself bound to a job. */
export function sessionKeyRefusal(agent: Agent): string | null {
  if (!agent.row || agent.kind !== "driver") {
    return `session_key is for a minted driver agent claiming before it launches an unattended session; ${agent.actor} is not one.`;
  }
  if (agent.job) return `${agent.actor} is bound to job ${agent.job} and cannot mint a key for another.`;
  if (agent.name.includes(SESSION_KEY_SEPARATOR)) return `${agent.actor} is a session key and cannot mint another.`;
  return null;
}

/** The LIKE pattern that matches the actors of a driver's session keys. */
export function sessionKeyPattern(actor: string): string {
  return `${actor}${SESSION_KEY_SEPARATOR}%`;
}

/** The driver actor a session key's actor was minted for, or the actor unchanged. */
export function sessionKeyDriver(actor: string): string {
  const at = actor.indexOf(SESSION_KEY_SEPARATOR);
  return actor.startsWith("agent:") && at > "agent:".length ? actor.slice(0, at) : actor;
}

const sqliteTime = (now: Date) => now.toISOString().slice(0, 19).replace("T", " ");

/** The key minted to hold one job, and the INSERT that goes in the claim's batch. The
 *  key is returned once and stored only as its sha256, as every agent key is. */
export async function mintSessionKey(db: D1Database, driver: Agent, jobId: string, now: Date): Promise<SessionKey> {
  const key = mintAgentKey();
  const hash = await sha256Hex(key);
  const suffix = mintAgentId().slice(-6);
  const name = `${driver.name}${SESSION_KEY_SEPARATOR}${jobId}.${suffix}`;
  const scopes = serializeScopes({ ...driver.scopes, max_claims: 1 });
  return {
    name,
    key,
    fingerprint: hash.slice(0, 12),
    note: "This key is shown ONCE and works for this job only, while its lease is live. Hand it to the session's MCP config and nowhere else; it stops resolving when the job is completed, failed, blocked or its lease lapses.",
    statements: [
      db
        .prepare("INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, job_id) VALUES (?1, ?2, 'session', ?3, ?4, ?5, ?6, ?7)")
        .bind(mintAgentId(), name, hash, scopes, driver.actor, sqliteTime(now), jobId),
    ],
  };
}
