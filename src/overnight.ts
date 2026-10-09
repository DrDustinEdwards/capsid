import type { Env } from "./env";
import { IMPROVE_MODES } from "./improve-schema";
import { auditStatement } from "./store-guards";
import { logEvent } from "./log";

// THE OVERNIGHT RUN SWITCH (capsid/research/design-automation-for-speed.md, D2 and D3, ruled
// by Dustin 2026-10-04). A scheduled run of the per-namespace drivers on Dustin's own
// machine (scripts/schedule-drivers.mjs), off unless he turns it on, with a "Runs on"
// choice of API key or subscription. It reuses the improve loop's three values
// (IMPROVE_MODES: api, subscription, off) and its Portal pattern: a reason on every
// change, an audit row, and the value read back.
//
// What the switch is NOT: the way work normally runs. Hand-started VS Code tabs that
// chain jobs are ordinary use Dustin starts himself; they are the default and this
// switch does not touch them.
//
// Choosing the subscription records the decision where the switch is set, as the ruling
// requires: who decided, when, and the reasoning, kept beside the mode in APP_KV and in
// the audit row. The scheduler refuses to run on the subscription without that record.

export const OVERNIGHT_MODE_KEY = "overnight:mode";
export const OVERNIGHT_DECISION_KEY = "overnight:decision";

export type OvernightMode = (typeof IMPROVE_MODES)[number];

// The ruling, in one place, so the record and the Portal's confirm text say the same
// thing. The reasoning is Dustin's, from capsid/decisions.md "2026-10-04: overnight runs
// may use the subscription, by Dustin's choice". Sources and quotes:
// capsid/research/terms-scheduled-claude-code.md.
export const SUBSCRIPTION_DECISION = {
  decided_by: "Dustin Edwards",
  decided_on: "2026-10-04",
  ruling: "capsid/decisions.md, 2026-10-04: overnight runs may use the subscription, by Dustin's choice",
  reasoning:
    "The use is personal, on Dustin's own repositories, and not shared. Anthropic's Agent SDK support page (updated 2026-06-16) says claude -p on a plan draws from subscription limits and directs shared production automation to API keys; Dustin reads shared as the operative word. The Consumer Terms clause on automated or non-human access (section 3) is the counterweight: the pages do not settle the question and the risk is to Dustin's own account.",
} as const;

export interface OvernightDecision {
  decided_by: string;
  decided_on: string;
  ruling: string;
  reasoning: string;
  // Who set the switch, when, and the reason given at the switch.
  set_by: string;
  set_at: string;
  reason: string;
}

export interface OvernightState {
  mode: OvernightMode;
  // The recorded decision, present only while the mode is subscription.
  decision: OvernightDecision | null;
}

const isMode = (value: unknown): value is OvernightMode => typeof value === "string" && (IMPROVE_MODES as readonly string[]).includes(value);

function parseDecision(raw: string | null): OvernightDecision | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<OvernightDecision> | null;
    if (
      value &&
      typeof value.decided_by === "string" &&
      typeof value.decided_on === "string" &&
      typeof value.ruling === "string" &&
      typeof value.reasoning === "string" &&
      typeof value.set_by === "string" &&
      typeof value.set_at === "string" &&
      typeof value.reason === "string"
    ) {
      return value as OvernightDecision;
    }
  } catch (err) {
    logEvent("error", "OVERNIGHT_DECISION_UNREADABLE", { message: `OVERNIGHT_DECISION_UNREADABLE: ${err instanceof Error ? err.message : String(err)}; treating the record as absent` });
    return null;
  }
  // Valid JSON of another shape: reported and read as absent, never as a decision.
  logEvent("error", "OVERNIGHT_DECISION_UNREADABLE", {
    message: "OVERNIGHT_DECISION_UNREADABLE: the stored decision record is not the shape setOvernight writes; treating it as absent",
  });
  return null;
}

/**
 * The switch as stored. Anything unreadable or unexpected is off: a switch that fails
 * open would start a scheduled run on a value nobody set. The subscription mode with no
 * readable decision record reads as off for the same reason.
 */
export async function overnightState(env: Env): Promise<OvernightState> {
  try {
    const mode = await env.APP_KV.get(OVERNIGHT_MODE_KEY);
    if (!isMode(mode) || mode === "off") return { mode: "off", decision: null };
    if (mode === "api") return { mode, decision: null };
    const decision = parseDecision(await env.APP_KV.get(OVERNIGHT_DECISION_KEY));
    return decision ? { mode, decision } : { mode: "off", decision: null };
  } catch (err) {
    logEvent("error", "OVERNIGHT_UNREADABLE", { message: `OVERNIGHT_UNREADABLE: ${err instanceof Error ? err.message : String(err)}; treating the switch as off` });
    return { mode: "off", decision: null };
  }
}

export function overnightValueRefusal(value: string | undefined): string | null {
  return isMode(value) ? null : `overnight must be one of ${IMPROVE_MODES.join(", ")}; got '${value ?? ""}'.`;
}

/** What setting the switch will record, for the confirm step and the audit row. */
export function decisionFor(value: OvernightMode, actor: string, now: Date, reason: string): OvernightDecision | null {
  return value === "subscription" ? { ...SUBSCRIPTION_DECISION, set_by: actor, set_at: now.toISOString(), reason } : null;
}

/**
 * Set the switch, audited, and read back. The reason is required: turning automation on
 * or off needs one (ruled 2026-09-30). Choosing the subscription writes the decision
 * record in the same step; any other value deletes it, so a later choice of the
 * subscription records its own date and reason rather than inheriting an old one.
 */
export async function setOvernight(env: Env, actor: string, now: Date, opts: { value?: string; reason?: string }): Promise<{ action: "overnight" } & OvernightState> {
  const value = opts.value?.trim().toLowerCase();
  const bad = overnightValueRefusal(value);
  if (bad) throw new Error(`${bad} Nothing was changed.`);
  const reason = opts.reason?.trim();
  if (!reason) throw new Error("overnight needs a reason: why the overnight run goes on, off, or changes what it runs on. It is recorded with the change. Nothing was changed.");
  const mode = value as OvernightMode;
  const decision = decisionFor(mode, actor, now, reason);
  await env.APP_KV.put(OVERNIGHT_MODE_KEY, mode);
  if (decision) await env.APP_KV.put(OVERNIGHT_DECISION_KEY, JSON.stringify(decision));
  else await env.APP_KV.delete(OVERNIGHT_DECISION_KEY);
  await env.DB.batch([auditStatement(env.DB, actor, "overnight-set", null, null, { mode, reason, ...(decision ? { decision } : {}) })]);
  return { action: "overnight", ...(await overnightState(env)) };
}
