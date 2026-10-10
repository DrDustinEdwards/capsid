// The overnight run's guard: what scripts/schedule-drivers.mjs asks before it starts a
// scheduled driver session. Pure where it can be, so test/overnight-guard.test.ts drives
// every refusal. The switch itself lives in Capsid (src/overnight.ts); this reads it.
//
// The ruling (capsid/decisions.md, 2026-10-04, D3 of design-automation-for-speed.md): the
// scheduler is a switch, off unless Dustin turns it on, with a "Runs on" choice of API key
// or subscription. Hand-started VS Code tabs are unaffected and stay the default. This
// guard makes the choice honest:
//
//   off           no scheduled run starts.
//   api           the run starts only if ANTHROPIC_API_KEY is set, and nothing that would
//                 outrank it is set. The subscription token is removed from the session's
//                 environment, so the key is what authenticates.
//   subscription  the run starts only if the switch carries Dustin's recorded decision.
//                 The Console key and anything else that would outrank the subscription
//                 login is removed from the session's environment, so a run set to the
//                 subscription cannot bill the API by accident.
//
// Credential order is from code.claude.com/docs/en/authentication, "Authentication
// precedence", read 2026-10-04: cloud-provider variables, then ANTHROPIC_AUTH_TOKEN, then
// ANTHROPIC_API_KEY (in -p mode the key is always used when present), then apiKeyHelper,
// then CLAUDE_CODE_OAUTH_TOKEN, then a /login subscription. An apiKeyHelper in a settings
// file cannot be seen from here and outranks the subscription login; the run's own
// /status is the way to confirm which credential a night used.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @typedef {{ decided_by: string; decided_on: string; ruling: string; reasoning: string; set_by: string; set_at: string; reason: string }} Decision
 * @typedef {{ mode: "off" | "api" | "subscription"; decision: Decision | null }} OvernightState
 * @typedef {{ set: Record<string, string>; unset: string[] }} EnvChange
 * @typedef {{ run: true; runsOn: "api" | "subscription"; env: EnvChange; note: string } | { run: false; why: string }} Verdict
 */

// Variables that pick a provider ahead of the Console key.
export const PROVIDER_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

/** @param {string | undefined} value */
const present = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Whether a scheduled run may start, and the environment change it needs. Never starts on
 * a state it could not read, and never on a mode it does not know.
 * @param {OvernightState | null} state
 * @param {Record<string, string | undefined>} env
 * @returns {Verdict}
 */
export function decideRun(state, env) {
  if (!state || typeof state !== "object") return { run: false, why: "the overnight switch could not be read, so nothing starts." };
  if (state.mode === "off") return { run: false, why: "the overnight run is switched off (Portal, Automation, Overnight run)." };

  if (state.mode === "api") {
    if (!present(env.ANTHROPIC_API_KEY)) {
      return { run: false, why: "the overnight run is set to run on the API key, but ANTHROPIC_API_KEY is not set. It will not fall back to the subscription." };
    }
    // A subscription token pasted into the key variable would still bill the plan.
    if ((env.ANTHROPIC_API_KEY ?? "").trim().startsWith("sk-ant-oat")) {
      return { run: false, why: "ANTHROPIC_API_KEY holds a subscription OAuth token (sk-ant-oat...), not a Console API key. The run is set to the API key and will not use the subscription." };
    }
    if (present(env.ANTHROPIC_AUTH_TOKEN)) {
      return { run: false, why: "ANTHROPIC_AUTH_TOKEN is set and outranks ANTHROPIC_API_KEY, so the run could not be sure to authenticate with the key. Unset it." };
    }
    const provider = PROVIDER_VARS.find((v) => present(env[v]));
    if (provider) return { run: false, why: `${provider} is set and outranks ANTHROPIC_API_KEY, so the run would not use the key. Unset it.` };
    return {
      run: true,
      runsOn: "api",
      env: { set: {}, unset: ["CLAUDE_CODE_OAUTH_TOKEN"] },
      note: "runs on the Console API key; the subscription token is removed from the session's environment.",
    };
  }

  if (state.mode === "subscription") {
    const d = state.decision;
    if (!d || !present(d.decided_by) || !present(d.decided_on) || !present(d.reasoning)) {
      return { run: false, why: "the overnight run is set to the subscription, but the switch carries no recorded decision (who, when and why). Set it again from the Portal." };
    }
    return {
      run: true,
      runsOn: "subscription",
      env: { set: {}, unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", ...PROVIDER_VARS] },
      note: `runs on the subscription by the decision of ${d.decided_by} on ${d.decided_on} (${d.ruling}); the Console key and provider variables are removed from the session's environment.`,
    };
  }

  return { run: false, why: `the overnight switch holds an unknown mode '${String(/** @type {{ mode?: unknown }} */ (state).mode)}', so nothing starts.` };
}

/**
 * The environment a session gets: the parent's, with the change applied.
 * @param {Record<string, string | undefined>} parent
 * @param {EnvChange} change
 * @returns {Record<string, string>}
 */
export function childEnv(parent, change) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v !== undefined && !change.unset.includes(k)) out[k] = v;
  }
  return { ...out, ...change.set };
}

// THE PLAN, as the jobs list view returns it (src/overnight-plan.ts).

/**
 * @typedef {{ id: string; namespace: string; estimate_minutes: number; gated?: boolean }} PlannedJob
 * @typedef {{ repo: string; namespaces: string[]; heavy: boolean; jobs: PlannedJob[]; planned_minutes: number }} Lane
 * @typedef {{ budget_minutes: number; lanes: Lane[] }} Plan
 */

/**
 * The lane this namespace's session works, or null when nothing is planned for it.
 * @param {Plan} plan
 * @param {string} ns
 * @returns {Lane | null}
 */
export function laneFor(plan, ns) {
  const lane = plan.lanes.find((l) => l.namespaces.includes(ns) && l.jobs.length > 0);
  return lane ?? null;
}

/**
 * The prompt for one session. Job ids and estimates only, never titles: a title can
 * carry text from outside (a watcher finding quotes what a site served), and this goes
 * to a session that acts on it.
 * @param {Lane} lane
 * @param {number} budgetMinutes
 */
export function planPrompt(lane, budgetMinutes) {
  const lines = lane.jobs.map((j, i) => `${i + 1}. ${j.id} (about ${j.estimate_minutes} minutes${j.gated ? ", gated" : ""})`);
  const gated = lane.jobs.some((j) => j.gated);
  return [
    "/improve work",
    "",
    `Overnight plan for ${lane.repo}. Work only these jobs, in this order, one at a time:`,
    ...lines,
    "",
    "After a job completes or blocks, claim the next one in the list. A job that blocks stops only itself: do not wait for a person, move on to the next.",
    ...(gated
      ? ["A gated job needs a person only for its risky steps (a migration, a deploy, a secret, an account setting, deleting data): do its ordinary work, open its pull request, list each risky step there for the seat without doing it, block with the exact command, and move on."]
      : []),
    `Stop after the last job, or when about ${budgetMinutes} minutes have passed since you started. Do not claim any job that is not listed.`,
  ].join("\n");
}

// THE HEAVY LOCK. Repos that run heavy suites run one session at a time across the machine
// (conventions 4.1, CLAUDE.md "one heavy session at a time"). Scheduled tasks all start at
// the same minute, so the second heavy session waits for the first.

/**
 * @typedef {{ ns: string; pid: number; started: string }} LockInfo
 * @typedef {{ ok: true } | { ok: false; holder: LockInfo | null }} LockResult
 */

/**
 * Take the lock by creating the file, which fails when it exists. A lock older than
 * `staleMs` is a session that died without releasing it and is removed.
 * @param {string} path
 * @param {LockInfo} info
 * @param {{ now?: () => number; staleMs?: number }} [opts]
 * @returns {LockResult}
 */
export function acquireHeavyLock(path, info, { now = Date.now, staleMs = 9 * 3_600_000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify(info));
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (err) {
      if (!(err instanceof Error) || /** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
    }
    const holder = readLock(path);
    const age = holder ? now() - Date.parse(holder.started) : Number.POSITIVE_INFINITY;
    // An unreadable lock file is as stale as one past its time: nothing can say who holds it.
    if (age <= staleMs) return { ok: false, holder };
    rmSync(path, { force: true });
  }
  return { ok: false, holder: readLock(path) };
}

/** @param {string} path @returns {LockInfo | null} */
function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed.ns === "string" && typeof parsed.started === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Release only a lock this session holds. @param {string} path @param {string} ns */
export function releaseHeavyLock(path, ns) {
  const holder = readLock(path);
  if (holder && holder.ns === ns) rmSync(path, { force: true });
}

/**
 * Wait for the lock, polling, up to `waitMs`.
 * @param {string} path
 * @param {LockInfo} info
 * @param {{ waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; staleMs?: number }} opts
 * @returns {Promise<LockResult>}
 */
export async function waitForHeavyLock(path, info, { waitMs, pollMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, staleMs }) {
  const deadline = now() + waitMs;
  for (;;) {
    const got = acquireHeavyLock(path, info, { now, ...(staleMs === undefined ? {} : { staleMs }) });
    if (got.ok || now() >= deadline) return got;
    await sleep(pollMs);
  }
}

// PREPARING A RUN.

/**
 * What the run needs before it starts: the switch, the plan, and the verdict. Reads only.
 * @param {{ tool(name: string, args: object): Promise<string> }} client
 * @param {string} ns
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ run: false; why: string; benign: boolean } | { run: true; runsOn: "api" | "subscription"; env: EnvChange; note: string; prompt: string; heavy: boolean; budget: number }>}
 */
export async function prepareRun(client, ns, env) {
  /** @type {OvernightState | null} */
  let state = null;
  try {
    const status = JSON.parse(await client.tool("improve_status", { namespace: ns }));
    state = status && typeof status === "object" && status.overnight ? status.overnight : null;
  } catch (err) {
    return { run: false, why: `could not read the overnight switch: ${err instanceof Error ? err.message : String(err)}`, benign: false };
  }
  const verdict = decideRun(state, env);
  if (!verdict.run) return { run: false, why: verdict.why, benign: false };

  /** @type {Plan} */
  let plan;
  try {
    plan = JSON.parse(await client.tool("jobs", { action: "list", view: "plan", namespace: ns }));
  } catch (err) {
    return { run: false, why: `could not read the overnight plan: ${err instanceof Error ? err.message : String(err)}`, benign: false };
  }
  const lane = laneFor(plan, ns);
  if (!lane) return { run: false, why: `nothing is planned for ${ns} tonight (no queued job fits).`, benign: true };
  return { run: true, runsOn: verdict.runsOn, env: verdict.env, note: verdict.note, prompt: planPrompt(lane, plan.budget_minutes), heavy: lane.heavy, budget: plan.budget_minutes };
}
