import type { Env } from "./env";
import type { PortalAction, PortalPreview } from "./ops-types/portal";
import { performAction } from "./controls-perform";
import type { ActionResult } from "./controls-perform-base";
import { planAction } from "./controls-plan";
import type { Plan } from "./controls-plan-base";
import { confirmKeys } from "./auth";
import { mintConfirm, redeemConfirm } from "@dustinedwards/site-runtime/confirm-token";
import {
  type ActionParams,
  PORTAL_ACTIONS,
  portalOnlyRefusal,
  type Surface,
  UNKNOWN_ACTION,
} from "./controls-base";

// THE CONTROLS' CORE (capsid/research/design-portal-full-controls.md, section 2): what each admin
// control is, what it will do, the one dispatch to the shared mutators, and the signed
// confirmation both surfaces use.

export const TOKEN_TTL_SECONDS = 5 * 60;

// The controls' confirmation key label (auth.ts confirmKeys): its own, so a namespace delete's
// token never performs a control. A new label retires every outstanding token.
const CONFIRM_LABEL = "capsid-portal-confirm:v2";

function describeAction(action: PortalAction, params: ActionParams): string {
  const ns = params.namespace ?? "";
  switch (action) {
    case "pr_close":
      return `Close pull request #${params.number ?? ""} in ${ns}${params.repo ? ` (${params.repo})` : ""} without merging it. Its head branch is deleted as capsid_close_pr action close deletes it. GitHub can reopen it; the Portal does not.`;
    case "revoke_agent":
      return `Revoke the agent ${params.name ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
    case "activate_agent":
      return `Activate the agent ${params.name ?? ""}. Its key starts resolving on the next request, with the scopes it was minted with.`;
    case "site_add":
      return params.origin
        ? `Add ${ns} to the sites Capsid Portal watches. The watcher probes it from its next pass.`
        : `Record that ${ns} serves no site, so the site-map check stops reporting it as unmapped.`;
    case "site_edit":
      return `Change how Capsid Portal watches ${ns}. The watcher reads the new row on its next pass.`;
    case "site_remove":
      return `Remove ${ns} from the Portal's site configuration. The watcher stops probing it on its next pass.`;
    case "package_add":
      return `Add the npm package ${params.name ?? ""} to the packages Capsid Portal watches. The watcher reads it from its next pass.`;
    case "package_edit":
      return `Change how Capsid Portal watches the package ${params.name ?? ""}. The watcher reads the new row on its next pass.`;
    case "package_remove":
      return `Remove the package ${params.name ?? ""} from the Portal. The watcher stops reading it; its weekly rows are kept.`;
    case "site_repair":
      return `Run ${params.tool ?? ""} on ${ns} through its operator API. It re-derives one of the site's stores from its source and reports whether it converged. Capsid calls only the site's allowlisted repairs; it never merges and never mints.`;
    case "site_backup":
      return params.namespace === "capsid"
        ? "Back up Capsid's own D1 dump now: the nightly 09:00 UTC run, on demand, under the cron's lease."
        : params.namespace
          ? `Back up ${params.namespace} now: its own backup jobs (its D1 dump and its files passes) run through its operator API's run_job, the same jobs as its nightly cron, recorded in its cron_runs.`
          : "Back up every site now: each site's own backup jobs (its D1 dump and its files passes) run through its operator API's run_job, at once, the same jobs as their nightly crons, recorded in their cron_runs.";
    case "run_job":
      return `Run ${params.name ?? ""} on ${ns} now: the job its cron runs, through the same code and record, at once instead of at its hour. Capsid asks the site to run its own job; it never runs a site's work itself.`;
    case "namespace_add":
      return `Register the project ${ns} with its repo mapping. The repo tools resolve through the mapping, so it is what an agent scoped to ${ns} may reach; its driver agent is minted separately.`;
    case "namespace_edit":
      return `Change the repo mapping of the project ${ns}. The repo tools resolve through it from the next call, so it changes what an agent scoped to ${ns} may reach. The namespace is not renamed and its documents do not move.`;
    case "namespace_remove":
      return `Delete the project ${ns}: its live documents (each snapshotted first) and their links, its site row and its registration. Archived documents, versions and the audit log are kept, and registering ${ns} again brings the archived documents back into scope.`;
    case "site_key_rotate":
      return `Mint a new operator key for ${ns}'s site API and set it on the site's Worker, then on Carrel. The old key stops working on each side as it is replaced. The new key is never shown, logged or recorded.`;
  }
}

// The params each action takes. Anything else is refused rather than carried into a token nobody
// reads.
const FIELDS: Record<PortalAction, readonly string[]> = {
  pr_close: ["namespace", "repo", "number", "reason"],
  revoke_agent: ["name"],
  activate_agent: ["name"],
  site_add: ["namespace", "name", "origin", "health_path", "platform", "script", "operator"],
  site_edit: [
    "namespace",
    "revision",
    "name",
    "origin",
    "health_path",
    "platform",
    "script",
    "operator",
  ],
  site_remove: ["namespace", "revision"],
  package_add: ["name", "repo", "formerly"],
  package_edit: ["name", "revision", "repo", "formerly"],
  package_remove: ["name", "revision"],
  site_repair: ["namespace", "tool"],
  site_backup: ["namespace"],
  run_job: ["namespace", "name"],
  namespace_add: ["namespace", "repo", "label", "repos"],
  // The digest of the mapping its preview read is bound into the token (Plan.bind).
  namespace_edit: ["namespace", "repos"],
  // The plan's fingerprint is bound into the token (Plan.bind), as the tool's own token binds it.
  namespace_remove: ["namespace", "cascade", "allow_improve_paths"],
  site_key_rotate: ["namespace"],
};

function paramsFrom(
  action: PortalAction,
  raw: unknown,
): { ok: true; params: Record<string, string> } | { ok: false; refusal: string } {
  if (raw === undefined) raw = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, refusal: "params must be an object of strings." };
  const allowed = FIELDS[action];
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        refusal: `${action} takes ${allowed.join(" and ")}; '${key}' is not one of them.`,
      };
    }
    if (typeof value !== "string")
      return { ok: false, refusal: `${action}'s ${key} must be a string.` };
    if (value.trim()) params[key] = value.trim();
  }
  return { ok: true, params };
}

/**
 * One control: its name, the params it takes, and the two steps every
 * surface goes through. plan writes nothing. perform calls the one mutator that exists for the
 * control, then writes the click's audit row.
 */
export interface Control {
  name: PortalAction;
  fields: readonly string[];
  plan(env: Env, email: string, params: Record<string, string>, surface: Surface): Promise<Plan>;
  perform(
    env: Env,
    email: string,
    source: string | null,
    now: Date,
    params: ActionParams,
    surface: Surface,
  ): Promise<ActionResult>;
}

export const CONTROLS: readonly Control[] = PORTAL_ACTIONS.map((name) => ({
  name,
  fields: FIELDS[name],
  plan: (env, email, params, surface) => planAction(env, email, name, params, surface),
  perform: (env, email, source, now, params, surface) =>
    performAction(env, email, source, now, name, params, surface),
}));

function controlNamed(name: unknown): Control | null {
  return typeof name === "string" ? (CONTROLS.find((c) => c.name === name) ?? null) : null;
}

const NONCE_PREFIX = "control-nonce:";

export type Previewed =
  | { ok: true; preview: PortalPreview }
  | { ok: false; status: number; refusal: string };

/**
 * The preview step for either surface: validate the name and params, plan from the state now (a
 * read, never a write), and sign a confirmation for the email.
 */
export async function previewControl(
  env: Env,
  email: string,
  name: unknown,
  rawParams: unknown,
  now: Date,
  surface: Surface,
): Promise<Previewed> {
  const control = controlNamed(name);
  if (!control)
    return {
      ok: false,
      status: 400,
      refusal: UNKNOWN_ACTION(typeof name === "string" ? name : ""),
    };
  const portalOnly = portalOnlyRefusal(control.name, surface);
  if (portalOnly) return { ok: false, status: 403, refusal: portalOnly };
  const parsed = paramsFrom(control.name, rawParams);
  if (!parsed.ok) return { ok: false, status: 400, refusal: parsed.refusal };
  const plan = await control.plan(env, email, parsed.params, surface);
  if (!plan.ok) return { ok: false, status: 400, refusal: plan.refusal };
  const { token, expiresAt } = await mintConfirm({
    keys: await confirmKeys(env, CONFIRM_LABEL),
    claims: { action: control.name, params: { ...parsed.params, ...plan.bind }, email },
    ttlSeconds: TOKEN_TTL_SECONDS,
    now: now.getTime(),
  });
  return {
    ok: true,
    preview: {
      action: control.name,
      summary: describeAction(control.name, parsed.params),
      changes: plan.changes,
      audit: plan.audit,
      token,
      expires_at: expiresAt,
    },
  };
}

export type Performed =
  | { ok: true; action: PortalAction; result: Extract<ActionResult, { ok: true }> }
  | { ok: false; status: number; refusal: string };

/**
 * The perform step for either surface: the token must verify for the email, and redeemConfirm
 * spends it (a confirmation is used once, whichever surface took it), then the control runs.
 */
export async function performControl(
  env: Env,
  email: string,
  token: unknown,
  source: string | null,
  now: Date,
  surface: Surface,
): Promise<Performed> {
  if (typeof token !== "string")
    return { ok: false, status: 400, refusal: "a perform needs the token its preview returned." };
  const redeemed = await redeemConfirm({
    keys: await confirmKeys(env, CONFIRM_LABEL),
    token,
    expect: { email },
    kv: env.APP_KV,
    prefix: NONCE_PREFIX,
    now: now.getTime(),
  });
  if (!redeemed.ok) return { ok: false, status: redeemed.status, refusal: redeemed.reason };
  const { action, params } = redeemed.claims;
  const control = controlNamed(action);
  if (!control) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(action)) };
  const portalOnly = portalOnlyRefusal(control.name, surface);
  if (portalOnly) return { ok: false, status: 403, refusal: portalOnly };
  if (!isStringRecord(params))
    return {
      ok: false,
      status: 403,
      refusal:
        "the confirmation token verifies but its params are not the shape this Worker signs: preview again.",
    };

  const result = await control.perform(env, email, source, now, params, surface);
  if (!result.ok) return { ok: false, status: 400, refusal: result.refusal };
  return { ok: true, action: control.name, result };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
