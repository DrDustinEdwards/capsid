import { seatStartState, sessionsInFlight, type SeatStartState } from "./seat-start";
import { TRANSITIONS_KEY, transitionMode, type TransitionMode } from "./skills-evaluate";
import { sha256Hex } from "./auth";
import { bytesToHex } from "./encoding";
import type { Env } from "./env";
import {
  BUDGET_KEY,
  DEFAULT_CONDITION,
  DRIVER_LEASE_TTL_SECONDS,
  IMPROVE_MODES,
  MODE_KEY,
  ROSTER,
  RUN_CONDITIONS,
  driverKey,
  isRunCondition,
  pausedKey,
  servedProtectedPaths,
  type BudgetCaps,
  type ImproveMode,
  type RunCondition,
  type ServedProtectedPath,
} from "./improve-schema";
import { verifyAnchors } from "./improve-scores";
import { loadGatePolicy } from "./gate-policy";
import { loadMergePolicy } from "./auto-merge-policy";
import {
  IMPROVE_ACTOR,
  improveAudit,
  pauseNamespace,
  pausedReason,
  readBest,
  readBudget,
  readMode,
} from "./improve-state";
import { verifyTaskDoc } from "./improve-task";
import { SCOPE_FLAGS, parseScopes } from "./agents-schema";
import { loadAgentRecords, type AgentRecord } from "./agent-record";
import { jobsSummary, type JobsSummary } from "./jobs";
import { integrityOf, REPORTS_PREFIX } from "./truth-report";
import {
  checkBudget,
  loadScores,
  openOne,
  openRuns,
  type BudgetStatus,
  type OpenOutcome,
} from "./improve/open";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import { tickRuns, type TickOutcome } from "./improve/tick";

// The barrel: only what something outside src/improve/ imports.
export { ingestScore } from "./improve/ingest";
export { checkBudget, openRuns } from "./improve/open";
export { tickRuns } from "./improve/tick";

// Verifies one task document before the driver executes it: its signature against the
// Worker's derived key, and its last audit actor against the loop's own actor. Both
// must hold. Read-only.
export async function verifyTaskDocument(
  env: Env,
  namespace: string,
  path: string
): Promise<{ path: string; namespace: string; ok: boolean; actor: string | null; reason: string | null }> {
  const row = await env.DB
    .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ body: string | null }>();
  if (!row) {
    return { path, namespace, ok: false, actor: null, reason: `no document at ${namespace}/${path}` };
  }
  const actorRow = await env.DB
    .prepare("SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1")
    .bind(namespace, path)
    .first<{ actor: string | null }>();
  const actor = actorRow?.actor ?? null;
  const verdict = await verifyTaskDoc(env.IMPROVE_SCORE_SECRET, row.body ?? "", actor, IMPROVE_ACTOR);
  return { path, namespace, ok: verdict.ok, actor, reason: verdict.ok ? null : verdict.reason };
}

// Skill counts by state, offered versus used, and the last evaluation, per namespace.
async function skillsSummary(db: D1Database, namespace: string): Promise<SkillsSummary> {
  const counts = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM improve_skills
       WHERE namespaces IS NULL OR namespaces LIKE ?1 GROUP BY status`
    )
    .bind(`%"${namespace}"%`)
    .all<{ status: string; n: number }>();
  const by = new Map((counts.results ?? []).map((r) => [r.status, r.n]));

  // Counted from the outcome rows so the numbers cannot drift from the jobs. SUM skips
  // the NULL from json_array_length, so a job that recorded nothing counts in neither
  // total. A superseded job attempted nothing, so its row is left out.
  const gap = await db
    .prepare(
      `SELECT COALESCE(SUM(json_array_length(skill_ids_offered)), 0) AS offered,
              COALESCE(SUM(json_array_length(skill_ids_used)), 0) AS used
       FROM job_outcomes o
       WHERE o.namespace = ?1
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = o.job_id AND j.status = 'superseded')`
    )
    .bind(namespace)
    .first<{ offered: number; used: number }>();

  const latest = await db
    .prepare("SELECT MAX(evaluated_at) AS last FROM skill_evaluations WHERE namespace = ?1")
    .bind(namespace)
    .first<{ last: string | null }>();

  const offered = gap?.offered ?? 0;
  return {
    candidate: by.get("candidate") ?? 0,
    live: by.get("live") ?? 0,
    retired: by.get("retired") ?? 0,
    offered,
    used: gap?.used ?? 0,
    use_rate: offered > 0 ? (gap?.used ?? 0) / offered : null,
    last_evaluation: latest?.last ?? null,
  };
}

export interface NamespaceStatus {
  namespace: string;
  paused: string | null;
  anchor_pinned: boolean;
  anchor_problem: string | null;
  best: { sha: string; score: number; recorded_at: string } | null;
  last_run: {
    id: string;
    status: string;
    started: string;
    finished: string | null;
    attempts: number;
    kept: number;
    reverts: number;
    cost_usd: number;
    ci_minutes: number;
    condition: string;
    pr_url: string | null;
    note: string | null;
  } | null;
  totals: { runs: number; attempts: number; kept: number; reverts: number; cost_usd: number; ci_minutes: number };
  // The latest `lint` report document under reports/. null means no report was ever
  // run here, which is not an integrity of zero.
  latest_report: { path: string; integrity: number | null; generated: string } | null;
  // Counts for the open states and today's moves, plus the blocked jobs themselves with
  // the command each waits on, because a count alone tells nobody what to run.
  jobs: JobsSummary;
  // Pull requests the auto-merge policy declined, each with the refusing check. The
  // tick rewrites the whole list, so it needs no expiry. Empty when the policy is off.
  awaiting_seat: AwaitingSeat[];
  // Counts by status, plus offered versus used: a skill offered often and used rarely
  // has a trigger condition that does not describe the work.
  skills: SkillsSummary;
}

export interface SkillsSummary {
  candidate: number;
  live: number;
  retired: number;
  // Across every finished job that recorded them; a job that recorded nothing counts in neither.
  offered: number;
  used: number;
  // null, not zero, when nothing has been offered.
  use_rate: number | null;
  // Lets a reader tell a quiet lifecycle from a stalled one.
  last_evaluation: string | null;
}

export interface StatusReport {
  mode: ImproveMode;
  mode_note: string | null;
  // Present only when the caller asked about one task document. The /improve
  // driver passes the path it is about to execute and refuses on ok:false.
  task_verification?: { path: string; namespace: string; ok: boolean; actor: string | null; reason: string | null };
  // An estimate; see the RATES comment in src/improve-anthropic.ts.
  cost_note: string;
  // Monthly spend against the KV caps the opener and tick enforce.
  budget: BudgetStatus;
  // The subscription-mode driver runs outside every guard in this Worker. It applies
  // these patterns to each attempt's changed paths before any push
  // (scripts/path-guard.mjs). Served rather than copied so a new pattern reaches it.
  protected_paths: ServedProtectedPath[];
  // The version a driver passes as approved_by_policy, served here because a
  // namespace-scoped driver cannot read the capsid namespace. Only the version and
  // whether it is on, never the body. Reported only when the policy loads (signature
  // verified, agreeing with the code); otherwise the reason it does not.
  policies: PolicyVersions;
  // Whether the seat may start sessions on GitHub's runners, the cap, and how many are
  // in flight now (src/seat-start.ts). Off unless switched on.
  // in_flight is null while the switch is off: nothing new can start, and the count is
  // read only when it decides something.
  seat_start: SeatStartState & { in_flight: number | null };
  // The credential inventory. Revoked rows are included and say so, so "revoked" and
  // "never existed" look different. Never the key or the stored verifier, and only the
  // flags an agent holds. Absent, not empty, for a scoped caller: an empty list would
  // read as "no agents exist".
  agents?: AgentSummary[];
  namespaces: NamespaceStatus[];
}

export interface AgentSummary {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  grants: string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  // What this credential has done, from job_outcomes. Counts and rates, never a
  // composite score (src/agent-record.ts says why).
  record: AgentRecord;
}

async function agentSummaries(db: D1Database): Promise<AgentSummary[]> {
  const { results } = await db
    .prepare("SELECT name, kind, scopes, last_seen, revoked_at FROM agents ORDER BY revoked_at IS NOT NULL, name")
    .all<{ name: string; kind: string; scopes: string; last_seen: string | null; revoked_at: string | null }>();
  const inventory = (results ?? []).map((row) => {
    const scopes = parseScopes(row.scopes);
    return {
      name: row.name,
      kind: row.kind,
      namespaces: scopes.namespaces,
      grants: scopes.grants,
      flags: SCOPE_FLAGS.filter((flag) => scopes.flags[flag]),
      last_seen: row.last_seen,
      revoked_at: row.revoked_at,
    };
  });
  // Three grouped reads for the whole inventory, not three per credential.
  const records = await loadAgentRecords(db, inventory);
  return inventory.map((agent) => ({ ...agent, record: records[agent.name] }));
}

/** One signed policy as a driver needs it: which version, and whether it is on. */
export type ServedPolicy = { version: string; enabled: boolean } | { reason: string };

export interface PolicyVersions {
  gates: ServedPolicy;
  auto_merge: ServedPolicy;
}

async function servedPolicies(env: Env): Promise<PolicyVersions> {
  // Each load verifies the stored document's signature and checks it describes no less
  // than the code enforces. A throw is reported, not raised: a driver asking what
  // version is current should not have status fail because a policy is being re-signed.
  const one = async (load: () => Promise<{ policy: { version: string; enabled: boolean } } | { error: string }>): Promise<ServedPolicy> => {
    try {
      const loaded = await load();
      return "error" in loaded ? { reason: loaded.error } : { version: loaded.policy.version, enabled: loaded.policy.enabled };
    } catch (err) {
      return { reason: `the policy could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  return { gates: await one(() => loadGatePolicy(env)), auto_merge: await one(() => loadMergePolicy(env)) };
}

async function seatStartStatus(env: Env): Promise<StatusReport["seat_start"]> {
  const state = await seatStartState(env);
  return { ...state, in_flight: state.enabled ? (await sessionsInFlight(env, new Date())).length : null };
}

export async function improveStatus(
  env: Env,
  only?: string,
  taskPath?: string,
  // The caller's namespaces and whether it is the admin, supplied by the tool from the
  // resolved agent. Omitted means unrestricted (the cron, the console). A scoped caller
  // sees only its own namespaces and no credential inventory, because both map the
  // boundary it sits behind.
  scope?: { namespaces: "*" | string[]; admin: boolean }
): Promise<StatusReport> {
  const { mode, reason } = await readMode(env.APP_KV);
  const budget = await checkBudget(env, new Date());
  const allowed = scope?.namespaces ?? "*";
  const requested = only ? [only] : [...ROSTER];
  const namespaces = allowed === "*" ? requested : requested.filter((n) => allowed.includes(n));
  const out: NamespaceStatus[] = [];

  // One read for every namespace. An unreadable or malformed key reports an empty set
  // rather than failing status.
  let awaitingAll: AwaitingSeat[] = [];
  try {
    const raw = await env.APP_KV.get(AWAITING_SEAT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) awaitingAll = parsed as AwaitingSeat[];
    }
  } catch {
    awaitingAll = [];
  }

  for (const namespace of namespaces) {
    const { doc, refusal } = await loadScores(env, namespace);
    const verification = await verifyAnchors(env.APP_KV, namespace, doc);
    const best = await readBest(env.APP_KV, namespace);
    const last = await env.DB
      .prepare(
        `SELECT id, status, started, finished, attempts, kept, reverts, cost_usd, ci_minutes, condition, pr_url, note
         FROM improve_runs WHERE namespace = ?1 ORDER BY started DESC LIMIT 1`
      )
      .bind(namespace)
      .first<NonNullable<NamespaceStatus["last_run"]>>();
    const totals = await env.DB
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(attempts),0) AS attempts, COALESCE(SUM(kept),0) AS kept,
                COALESCE(SUM(reverts),0) AS reverts, COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(ci_minutes),0) AS ci_minutes
         FROM improve_runs WHERE namespace = ?1`
      )
      .bind(namespace)
      .first<NamespaceStatus["totals"]>();

    const report = await env.DB
      .prepare(
        `SELECT path, body, updated_at FROM documents
         WHERE namespace = ?1 AND path LIKE ?2 AND type = 'reference'
         ORDER BY path DESC LIMIT 1`
      )
      .bind(namespace, `${REPORTS_PREFIX}lint-%`)
      .first<{ path: string; body: string | null; updated_at: string }>();

    out.push({
      namespace,
      paused: await pausedReason(env.APP_KV, namespace),
      anchor_pinned: Boolean(verification.pinned),
      anchor_problem: refusal,
      best: best ? { sha: best.sha, score: best.score, recorded_at: best.recorded_at } : null,
      last_run: last ?? null,
      totals: totals ?? { runs: 0, attempts: 0, kept: 0, reverts: 0, cost_usd: 0, ci_minutes: 0 },
      // The filename is ISO-dated, so ORDER BY path gives the newest date. updated_at
      // would give the most recently rewritten report instead.
      latest_report: report
        ? { path: `${namespace}/${report.path}`, integrity: integrityOf(report.body), generated: report.updated_at }
        : null,
      jobs: await jobsSummary(env.DB, namespace, new Date()),
      awaiting_seat: awaitingAll.filter((a) => a.namespace === namespace),
      skills: await skillsSummary(env.DB, namespace),
    });
  }

  // The driver's gate. Verified against the namespace it was asked about, so a
  // caller cannot ask about one namespace's doc while naming another.
  const task_verification =
    taskPath && only ? await verifyTaskDocument(env, only, taskPath) : undefined;

  return {
    mode,
    mode_note: reason,
    ...(task_verification ? { task_verification } : {}),
    cost_note:
      "cost_usd is an ESTIMATE computed from token counts and published rates, including cache read and write multipliers. It is for sanity-checking, not accounting.",
    budget,
    protected_paths: servedProtectedPaths(),
    policies: await servedPolicies(env),
    seat_start: await seatStartStatus(env),
    // Admin only: the inventory is the map an agent looking to widen itself would want.
    ...(scope && !scope.admin ? {} : { agents: await agentSummaries(env.DB) }),
    namespaces: out,
  };
}

export interface ManualResult {
  mode: ImproveMode;
  mode_note: string | null;
  condition: RunCondition;
  dry_run: boolean;
  opened: OpenOutcome[];
  advanced: TickOutcome[];
}

// What Capsid:improve_run calls. dry_run reports exactly what a real run would do
// and changes nothing: no branch, no dispatch, no row, no document.
export async function improveRunManual(
  env: Env,
  now: Date,
  opts: { namespace?: string; dryRun: boolean; condition?: string }
): Promise<ManualResult> {
  const { mode, reason } = await readMode(env.APP_KV);
  // An unrecognised condition is refused rather than defaulted, so the label on the row
  // can be trusted.
  if (opts.condition !== undefined && !isRunCondition(opts.condition)) {
    throw new Error(
      `unknown condition '${opts.condition}'. Valid conditions: ${RUN_CONDITIONS.join(", ")}. Nothing was opened.`
    );
  }
  const condition: RunCondition = opts.condition ?? DEFAULT_CONDITION;
  if (opts.dryRun) {
    const namespaces = opts.namespace ? [opts.namespace] : [...ROSTER];
    const opened: OpenOutcome[] = [];
    for (const ns of namespaces) {
      opened.push(await openOne(env, ns, mode, now, condition, { preview: true }));
    }
    return { mode, mode_note: reason, condition, dry_run: true, opened, advanced: [] };
  }
  const summary = await openRuns(env, now, opts.namespace, condition);
  // One tick immediately, so a hand-run does something visible rather than only
  // creating a row and waiting five minutes for the cron.
  const advanced = await tickRuns(env, now);
  return { mode: summary.mode, mode_note: summary.modeNote, condition, dry_run: false, opened: summary.outcomes, advanced };
}

// improve_run's non-run verbs. Each KV write is audited and read back, so the caller
// sees the value that landed. The registrar gates each action by
// TOOL_ACTION_GRANTS.improve_run in src/scope.ts: only run and claim take the write
// grant; every other action is admin.
export type ImproveControlResult =
  | { action: "mode"; requested: string; mode: ImproveMode; mode_note: string | null }
  | { action: "skill_transitions"; requested: string; mode: TransitionMode }
  | { action: "pause" | "unpause"; namespaces: string[]; paused: Record<string, string | null> }
  | { action: "budget"; caps: BudgetCaps }
  | {
      action: "claim";
      namespace: string;
      // True only when THIS call took the lease. A refused claim and a release
      // both report false, and `reason` says which.
      held: boolean;
      holder: string | null;
      expires_in_seconds: number | null;
      reason: string | null;
    }
  | {
      action: "mint_operator_key";
      key: string;
      hash: string;
      // The OPERATOR_KEY_HASH line, `ro:<hash>`. The tier lives on the entry, so it is
      // the operator's decision.
      entry: string;
      grant: "read-only";
      already_listed: boolean;
      next_step: string;
      command: string;
      warning: string;
    };

export async function improveControl(
  env: Env,
  action: "mode" | "pause" | "unpause" | "budget" | "mint_operator_key" | "claim" | "skill_transitions",
  opts: {
    value?: string;
    namespace?: string;
    reason?: string;
    actions_minutes_month?: number;
    model_usd_month?: number;
    release?: boolean;
  }
): Promise<ImproveControlResult> {
  // Mints a read-only operator key and prints the command that installs its hash. It
  // does not install it: a Worker that can widen its own authorization list does not
  // have one. The key is returned once and stored nowhere, not even the hash in the
  // audit row, because OPERATOR_KEY_HASH is the verifier; the row gets a fingerprint.
  if (action === "mint_operator_key") {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Hex through bytesToHex (src/encoding.ts).
    const key = `capsid_${bytesToHex(bytes)}`;
    // The `ro:` prefix goes on the list entry, not the key: src/auth.ts compares the
    // key's hash to each entry with the prefix stripped. Backwards, this mints a write key.
    const hash = await sha256Hex(key);
    const entry = `ro:${hash}`;
    const existing = (env.OPERATOR_KEY_HASH ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const alreadyListed = existing.includes(entry);
    const next = alreadyListed ? existing : [...existing, entry];
    await env.DB.batch([
      improveAudit(env.DB, "operator-key-minted", null, {
        // Tells two mints apart without being usable as a verifier.
        fingerprint: hash.slice(0, 8),
        grant: "read-only",
      }),
    ]);
    return {
      action: "mint_operator_key",
      key,
      hash,
      entry,
      grant: "read-only",
      already_listed: alreadyListed,
      next_step:
        "This key does NOTHING until its hash is in OPERATOR_KEY_HASH. Run the command below from a machine with wrangler and this account. The Worker deliberately cannot do it: a Worker that can widen its own authorization list does not have one.",
      command: `npx wrangler secret put OPERATOR_KEY_HASH
# then paste, on one line:
${next.join(",")}`,
      warning:
        "The key is shown ONCE and is stored nowhere: not in KV, not in a document, and not in the audit row. Copy it now. Lose it and mint another, then remove the stale hash from the list above. Revoke by removing a hash and putting the secret again.",
    };
  }

  // The driver lease, claimed before a subscription-mode run touches a clone. Best
  // effort: KV has no compare-and-set, so it stops a second driver started later, not
  // two claims in the same millisecond. The TTL frees the lease of a driver that died.
  if (action === "claim") {
    const target = (opts.namespace ?? "").trim();
    if (!target) throw new Error('claim needs a namespace. Nothing was changed.');
    if (!(ROSTER as readonly string[]).includes(target)) {
      throw new Error(`'${target}' is not on the improve roster (${ROSTER.join(", ")}). Nothing was changed.`);
    }
    const key = driverKey(target);
    if (opts.release === true) {
      await env.APP_KV.delete(key);
      await env.DB.batch([improveAudit(env.DB, "improve-driver-released", target, {})]);
      return { action: "claim", namespace: target, held: false, holder: null, expires_in_seconds: null, reason: "released" };
    }
    const holder = await env.APP_KV.get(key);
    if (holder !== null) {
      // Refused, and the holder is not overwritten.
      return {
        action: "claim",
        namespace: target,
        held: false,
        holder,
        expires_in_seconds: null,
        reason: `the driver lease for ${target} is already held (claimed ${holder}). Another /improve session is running, or one died without releasing and the lease expires within ${DRIVER_LEASE_TTL_SECONDS / 3600} hours.`,
      };
    }
    const claimedAt = new Date().toISOString();
    await env.APP_KV.put(key, claimedAt, { expirationTtl: DRIVER_LEASE_TTL_SECONDS });
    await env.DB.batch([improveAudit(env.DB, "improve-driver-claimed", target, { claimed_at: claimedAt })]);
    return {
      action: "claim",
      namespace: target,
      held: true,
      holder: claimedAt,
      expires_in_seconds: DRIVER_LEASE_TTL_SECONDS,
      reason: null,
    };
  }

  // Whether the skills evaluation cycle applies the status changes its evaluations
  // decide, or holds them (the observation window). Admin only, audited, and read
  // back through the resolver the cycle uses.
  if (action === "skill_transitions") {
    const value = (opts.value ?? "").trim().toLowerCase();
    if (value !== "hold" && value !== "apply") {
      throw new Error(`skill_transitions must be "hold" or "apply"; got '${opts.value ?? ""}'. Nothing was changed.`);
    }
    await env.APP_KV.put(TRANSITIONS_KEY, value);
    await env.DB.batch([improveAudit(env.DB, "skill-transitions-set", null, { mode: value })]);
    return { action: "skill_transitions", requested: value, mode: await transitionMode(env) };
  }

  if (action === "mode") {
    const value = (opts.value ?? "").trim().toLowerCase();
    if (!(IMPROVE_MODES as readonly string[]).includes(value)) {
      throw new Error(`mode must be one of ${IMPROVE_MODES.join(", ")}; got '${opts.value ?? ""}'. Nothing was changed.`);
    }
    await env.APP_KV.put(MODE_KEY, value);
    await env.DB.batch([improveAudit(env.DB, "improve-mode-set", null, { mode: value })]);
    // Read back through the resolver the loop uses, so an unexpected value surfaces here.
    const read = await readMode(env.APP_KV);
    return { action: "mode", requested: value, mode: read.mode, mode_note: read.reason };
  }

  if (action === "pause" || action === "unpause") {
    const target = (opts.namespace ?? "").trim();
    if (!target) throw new Error(`${action} needs a namespace, or "all". Nothing was changed.`);
    if (target !== "all" && !(ROSTER as readonly string[]).includes(target)) {
      throw new Error(`'${target}' is not on the improve roster (${ROSTER.join(", ")}) and is not "all". Nothing was changed.`);
    }
    const namespaces = target === "all" ? [...ROSTER] : [target];
    const reason = opts.reason?.trim() || "paused via improve_run";
    const audits = [];
    for (const ns of namespaces) {
      if (action === "pause") await pauseNamespace(env.APP_KV, ns, reason);
      else await env.APP_KV.delete(pausedKey(ns));
      audits.push(improveAudit(env.DB, action === "pause" ? "improve-paused" : "improve-unpaused", ns, action === "pause" ? { reason } : {}));
    }
    await env.DB.batch(audits);
    // Read each pause key back: pause returns the reason, unpause returns null.
    const paused: Record<string, string | null> = {};
    for (const ns of namespaces) paused[ns] = await pausedReason(env.APP_KV, ns);
    return { action, namespaces, paused };
  }

  const { actions_minutes_month, model_usd_month } = opts;
  for (const [label, n] of [["actions_minutes_month", actions_minutes_month], ["model_usd_month", model_usd_month]] as const) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`budget needs a positive number for ${label}; got ${JSON.stringify(n)}. Nothing was changed.`);
    }
  }
  await env.APP_KV.put(BUDGET_KEY, JSON.stringify({ actions_minutes_month, model_usd_month }));
  await env.DB.batch([improveAudit(env.DB, "improve-budget-set", null, { actions_minutes_month, model_usd_month })]);
  // Read back through readBudget so the caps returned are the ones the kill switch enforces.
  const caps = await readBudget(env.APP_KV);
  return { action: "budget", caps };
}
