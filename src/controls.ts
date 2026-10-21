import type { Env } from "./env";
import type { PortalAction, PortalPreview } from "./ops-types/portal";
import { type ActionResult, performAction } from "./controls-perform";
import { type Plan, planAction } from "./controls-plan";
import { signConfirm, verifyConfirm } from "./controls-token";
import { type ActionParams, PORTAL_ACTIONS, type Surface, SWITCHES, UNKNOWN_ACTION } from "./controls-base";

// THE CONTROLS' CORE (capsid/research/design-portal-full-controls.md, section 2): what each
// admin control is, what it will do, the one dispatch to the shared mutators, and the
// signed confirmation both surfaces use. It was the body of src/portal-actions.ts; the
// Portal's routes there and the `capsid_admin_run_controls` tool (src/tools/controls.ts) are its two
// callers, so a control is implemented once and parity is a property of this file and the
// controls-*.ts files beside it.

export const TOKEN_TTL_SECONDS = 5 * 60;

/** What each action is about to do, naming the target, for the confirm step. */
function describeAction(action: PortalAction, params: ActionParams): string {
  const said = describeOnce(action, params);
  return params.undo === "true" ? `Undo: ${said}` : said;
}

function describeOnce(action: PortalAction, params: ActionParams): string {
  const ns = params.namespace ?? "";
  const id = params.id ?? "";
  switch (action) {
    case "overnight":
      return params.value === "off"
        ? "Turn the overnight run OFF. No scheduled run starts; one already running finishes."
        : params.value === "subscription"
          ? "Set the overnight run to run on the SUBSCRIPTION. The scheduler may then start the per-namespace drivers on your machine overnight, billed against your Max plan. This records your decision, its date and its reasoning where the switch is set."
          : "Set the overnight run to run on the API key. The scheduler refuses to start unless it authenticates with ANTHROPIC_API_KEY and no subscription token is in use. Billed per token to your Console account.";
    case "resume_job":
      return `Resume blocked job ${id}. The job moves back to claimed under the driver that blocked it, and that driver continues it. It does not move to you. If the job was blocked by a shared identity such as your own admin session, it goes back to the queue with your approval instead, and the next free session claims it.`;
    case "release_job":
      return `Release job ${id} back to the queue. Whoever holds it loses the claim, the next free session claims it, and no outcome is recorded against the holder.`;
    case "fail_job":
      return `Mark job ${id} failed. This is the seat stepping in on a job it does not hold, and it is recorded as such.`;
    case "close_shipped":
      return `Close blocked job ${id} as shipped. Its work landed, so the job moves to done, and the outcome is credited to the driver that did the work, not to you. The pull requests it names are read from GitHub for the outcome, and the close is recorded as yours.`;
    case "supersede_job":
      return `Supersede job ${id}${params.replaced_by ? ` with ${params.replaced_by}` : ""}. It ends as superseded, replaced before any work was done: no outcome row is written against anybody.`;
    case "park_job":
      return `Park job ${id}. It stays listed but is never claimed or planned until somebody unparks it; the reason says when it comes back.`;
    case "unpark_job":
      return `Unpark job ${id}. It goes back to the queue at its priority, and the next free session may claim it.`;
    case "pr_close":
      return `Close pull request #${params.number ?? ""} in ${ns}${params.repo ? ` (${params.repo})` : ""} without merging it. Its head branch is deleted as capsid_close_pr action close deletes it. GitHub can reopen it; the Portal does not.`;
    case "approve_pr":
      return params.undo === "true"
        ? `Void the open approval of pull request ${params.prs ?? ""} in ${ns}. The executor will not merge it.`
        : `Approve pull request ${params.prs ?? ""} in ${ns} at the head you reviewed. Nothing merges now: the executor merges an approved pull request once CI is green on that exact sha, and a new push, red CI or 7 days voids the approval.`;
    case "revoke_agent":
      return `Revoke the agent ${params.name ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
    case "site_add":
      return params.origin
        ? `Add ${ns} to the sites Capsid Portal watches. The watcher probes it from its next pass.`
        : `Record that ${ns} serves no site, so the site-map check stops reporting it as unmapped.`;
    case "site_edit":
      return `Change how Capsid Portal watches ${ns}. The watcher reads the new row on its next pass.`;
    case "site_remove":
      return `Remove ${ns} from the Portal's site configuration. The watcher stops probing it on its next pass.`;
    case "reset_breaker":
      return `Reset the queue's circuit breaker for ${ns}. Jobs its drivers failed before now stop counting, so ${ns} hands out work again until the threshold is reached anew.`;
    case "package_add":
      return `Add the npm package ${params.name ?? ""} to the packages Capsid Portal watches. The watcher reads it from its next pass.`;
    case "package_edit":
      return `Change how Capsid Portal watches the package ${params.name ?? ""}. The watcher reads the new row on its next pass.`;
    case "package_remove":
      return `Remove the package ${params.name ?? ""} from the Portal. The watcher stops reading it; its weekly rows are kept.`;
    case "canon_approve":
      return `Approve canon proposal ${params.id ?? ""}. The document is written as proposed, with the current version snapshotted first, and only if it is still the body the proposal was written against.`;
    case "canon_reject":
      return `Reject canon proposal ${params.id ?? ""}. The document is not touched, and the proposer reads your reason.`;
    case "canon_approve_all":
      return "Decide every pending canon proposal at once. On each document the newest proposal is approved, written as the single Approve writes it, unless its document moved since it was written; older proposals on the same document, and outdated ones, are rejected with a reason the proposer reads.";
    case "site_repair":
      return `Run ${params.tool ?? ""} on ${ns} through its operator API. It re-derives one of the site's stores from its source and reports whether it converged. Capsid calls only the site's allowlisted repairs; it never merges and never mints.`;
    case "sign_policy_change":
      return params.change === "demote"
        ? `Write and sign the next version of the auto-merge policy without the merge unit ${params.unit ?? ""}: its pull requests wait for an approval again.`
        : `Write and sign the next version of the auto-merge policy with the merge unit ${params.unit ?? ""} promoted to auto: its pull requests may merge with no human when every other check passes. This widens autonomy, so the new version number is typed as confirm.`;
    case "sign_policy_from_repo":
      return "Write the auto-merge policy from docs/policy/auto-merge.md on the default branch, exactly as it reads there, and sign it. The version in the file is typed as confirm, because the policy decides what merges with no human.";
    case "unit_resume":
      return `Lift the suspension of the merge unit ${params.unit ?? ""}. The tick may merge its pull requests unattended again, and the rollbacks before now suspend it no more.`;
    case "automerge_resume":
      return `Lift the pause on auto-merge for ${ns}. The tick may merge its pull requests unattended again, and the rollbacks and reverts before now count against it no more.`;
  }
}

// The params each action takes. Anything else is refused rather than carried into a
// token nobody reads.
const FIELDS: Record<PortalAction, readonly string[]> = {
  overnight: ["value", "reason", "undo"],
  resume_job: ["id", "reason", "note"],
  release_job: ["id", "reason"],
  fail_job: ["id", "reason"],
  close_shipped: ["id", "reason"],
  supersede_job: ["id", "reason", "replaced_by"],
  park_job: ["id", "reason", "undo"],
  unpark_job: ["id", "reason", "undo"],
  pr_close: ["namespace", "repo", "number", "reason"],
  approve_pr: ["namespace", "repo", "prs", "shas", "confirm", "reason", "undo"],
  revoke_agent: ["name"],
  site_add: ["namespace", "name", "origin", "health_path", "platform", "script", "operator"],
  site_edit: ["namespace", "revision", "name", "origin", "health_path", "platform", "script", "operator"],
  site_remove: ["namespace", "revision"],
  reset_breaker: ["namespace"],
  package_add: ["name", "repo", "formerly"],
  package_edit: ["name", "revision", "repo", "formerly"],
  package_remove: ["name", "revision"],
  canon_approve: ["id"],
  canon_reject: ["id", "reason"],
  // The plan the preview read is bound into the token beside these (Plan.bind), so a
  // caller cannot send one.
  canon_approve_all: ["reason"],
  site_repair: ["namespace", "tool"],
  sign_policy_change: ["change", "unit", "confirm", "reason"],
  // The hash its preview read is bound into the token (Plan.bind), so a caller cannot send one.
  sign_policy_from_repo: ["confirm", "reason"],
  unit_resume: ["unit", "reason"],
  automerge_resume: ["namespace", "reason"],
};


/** The action's params from a preview body: only the fields it takes, each a string,
 *  trimmed, blanks dropped. */
function paramsFrom(action: PortalAction, raw: unknown): { ok: true; params: Record<string, string> } | { ok: false; refusal: string } {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, refusal: "params must be an object of strings." };
  const allowed = FIELDS[action];
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) {
      return { ok: false, refusal: `${action} takes ${allowed.join(" and ")}; '${key}' is not one of them.` };
    }
    if (typeof value !== "string") return { ok: false, refusal: `${action}'s ${key} must be a string.` };
    if (value.trim()) params[key] = value.trim();
  }
  return { ok: true, params };
}

// ---------------------------------------------------------------------------
// The registry and its two doors.

/** One control: its name, the params it takes, whether it needs a reason, and the two
 *  steps every surface goes through. plan writes nothing. perform calls the one
 *  mutator that exists for the control, then writes the click's audit row. */
export interface Control {
  name: PortalAction;
  fields: readonly string[];
  reasonRequired: boolean;
  plan(env: Env, email: string, params: Record<string, string>, surface: Surface): Promise<Plan>;
  perform(env: Env, email: string, source: string | null, now: Date, params: ActionParams, surface: Surface): Promise<ActionResult>;
}

export const CONTROLS: readonly Control[] = PORTAL_ACTIONS.map((name) => ({
  name,
  fields: FIELDS[name],
  reasonRequired: SWITCHES.has(name),
  plan: (env, email, params, surface) => planAction(env, email, name, params, surface),
  perform: (env, email, source, now, params, surface) => performAction(env, email, source, now, name, params, surface),
}));

function controlNamed(name: unknown): Control | null {
  return typeof name === "string" ? (CONTROLS.find((c) => c.name === name) ?? null) : null;
}

const randomJti = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const NONCE_PREFIX = "control-nonce:";

export type Previewed = { ok: true; preview: PortalPreview } | { ok: false; status: number; refusal: string };

/** The preview step for either surface: validate the name and params, plan from the state
 *  now (a read, never a write), and sign a confirmation for the email. */
export async function previewControl(env: Env, email: string, name: unknown, rawParams: unknown, now: Date, surface: Surface): Promise<Previewed> {
  const control = controlNamed(name);
  if (!control) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(typeof name === "string" ? name : "") };
  const parsed = paramsFrom(control.name, rawParams);
  if (!parsed.ok) return { ok: false, status: 400, refusal: parsed.refusal };
  const plan = await control.plan(env, email, parsed.params, surface);
  if (!plan.ok) return { ok: false, status: 400, refusal: plan.refusal };
  const exp = Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS;
  const token = await signConfirm(env, { v: 2, jti: randomJti(), action: control.name, params: { ...parsed.params, ...plan.bind }, email, exp });
  return {
    ok: true,
    preview: {
      action: control.name,
      summary: describeAction(control.name, parsed.params),
      changes: plan.changes,
      audit: plan.audit,
      token,
      expires_at: new Date(exp * 1000).toISOString(),
    },
  };
}

export type Performed = { ok: true; action: PortalAction; result: Extract<ActionResult, { ok: true }> } | { ok: false; status: number; refusal: string };

/** The perform step for either surface: the token must verify for the email, then it is
 *  spent (a confirmation is used once, whichever surface took it), then the control runs.
 *  A token is spent even when the control then refuses: the refusal is about state, and
 *  the next try starts from a fresh preview that shows the state as it is. KV has no
 *  compare-and-set, so two performs of one token inside the same instant could both
 *  pass the check; every mutator is guarded on the state it moves from, which is what
 *  stops the second. */
export async function performControl(env: Env, email: string, token: unknown, source: string | null, now: Date, surface: Surface): Promise<Performed> {
  if (typeof token !== "string") return { ok: false, status: 400, refusal: "a perform needs the token its preview returned." };
  const verified = await verifyConfirm(env, token, email, now);
  if (!verified.ok) return { ok: false, status: verified.status, refusal: verified.refusal };
  const { action, params, jti, exp } = verified.claims;
  const control = controlNamed(action);
  if (!control) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(action)) };

  const nonceKey = `${NONCE_PREFIX}${jti}`;
  if ((await env.APP_KV.get(nonceKey)) !== null) {
    return { ok: false, status: 409, refusal: "this confirmation was already used: preview again to get a new one." };
  }
  // Held until the token itself would have expired, plus a minute for clock skew, and not
  // under KV's 60 second floor.
  await env.APP_KV.put(nonceKey, now.toISOString(), { expirationTtl: Math.max(60, exp - Math.floor(now.getTime() / 1000) + 60) });

  const result = await control.perform(env, email, source, now, params, surface);
  if (!result.ok) return { ok: false, status: 400, refusal: result.refusal };
  return { ok: true, action: control.name, result };
}
