// sign_policy_change: promote or demote a merge unit in the signed policy.
import { commitSigned, POLICY_SIGN_NAMESPACE, readPriorDoc } from "./policy-sign";
import type { Env } from "./env";

import { splitSignedTask } from "./signed-docs";
import { auditStatement } from "./store-guards";
import { AUTO_MERGE_POLICY_PATH, loadMergePolicy } from "./auto-merge-policy";
import { parseMergePolicy } from "./auto-merge-policy-parse";

// sign_policy_change (docs/design/design-merge-pipeline.md section 7): promoting a merge unit to
// auto, or removing one, writes the next version of the auto-merge policy and signs it in one admin
// control. It widens autonomy, so the perform needs the new version number typed as confirm.

type PolicyChange = "promote" | "demote";

export type PolicyChangePlan =
  | {
      ok: true;
      from: string;
      to: string;
      unit: string;
      change: PolicyChange;
      body: string;
      prior: { title: string | null; body: string };
      changes: string[];
    }
  | { ok: false; error: string };

const UNITS_SECTION = "## Auto units";
const UNITS_INTRO =
  "Merge units promoted to auto by a signed policy change (sign_policy_change), each a namespace and a path class. A unit widens only the namespace's allowed paths; refused paths, money, migrations and workflows still refuse.";

/** `capsid/tests` or `capsid / tests` as the policy writes it, or null. */
function normalUnit(raw: string | undefined): string | null {
  const m = /^\s*([a-z0-9-]+)\s*\/\s*([a-z-]+)\s*$/.exec(raw ?? "");
  return m ? `${m[1]} / ${m[2]}` : null;
}

/** The body with the version bumped and one unit line added or removed. */
function editPolicy(body: string, to: string, change: PolicyChange, unit: string): string {
  const lines = body.split("\n");
  const v = lines.findIndex((l) => /^\s*- version:/i.test(l));
  lines[v] = `- version: ${to}`;
  const line = `- unit \`${unit}\``;
  const head = lines.findIndex((l) => l.trim().toLowerCase() === UNITS_SECTION.toLowerCase());
  if (change === "demote") return lines.filter((l) => l.trim() !== line).join("\n");
  if (head < 0)
    return `${lines.join("\n").replace(/\s*$/, "")}\n\n${UNITS_SECTION}\n\n${UNITS_INTRO}\n\n${line}\n`;
  let end = lines.findIndex((l, i) => i > head && l.trim().startsWith("##"));
  if (end < 0) end = lines.length;
  let at = head + 1;
  for (let i = head + 1; i < end; i++) if (lines[i]!.trim().startsWith("- unit ")) at = i + 1;
  if (at === head + 1) {
    lines.splice(at, 0, "", line);
  } else {
    lines.splice(at, 0, line);
  }
  return lines.join("\n");
}

/** What sign_policy_change will write, from the signed policy now. Reads only. */
export async function planPolicyChange(
  env: Env,
  change: string | undefined,
  rawUnit: string | undefined,
): Promise<PolicyChangePlan> {
  const refuse = (error: string): PolicyChangePlan => ({ ok: false, error });
  if (change !== "promote" && change !== "demote")
    return refuse(`sign_policy_change needs change: promote or demote; got '${change ?? ""}'.`);
  const unit = normalUnit(rawUnit);
  if (!unit)
    return refuse(
      `sign_policy_change needs unit as '<namespace>/<path class>', for example 'capsid/tests'; got '${rawUnit ?? ""}'.`,
    );
  if (!env.IMPROVE_SCORE_SECRET)
    return refuse(
      "signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no policy can be signed.",
    );
  // The policy in force must load first: a change is made to a policy the Worker trusts.
  const loaded = await loadMergePolicy(env);
  if ("error" in loaded)
    return refuse(
      `the auto-merge policy in force does not load, so it is not changed: ${loaded.error}`,
    );
  const from = loaded.policy.version;
  if (!/^[1-9][0-9]{0,5}$/.test(from))
    return refuse(
      `the policy's version is '${from}', not a whole number, so its next version cannot be named.`,
    );
  const to = String(Number(from) + 1);
  const listed = loaded.policy.units.includes(unit);
  if (change === "promote" && listed)
    return refuse(`${unit} is already promoted to auto in version ${from}.`);
  if (change === "demote" && !listed)
    return refuse(
      `${unit} is not promoted to auto in version ${from}, so there is nothing to remove.`,
    );
  const prior = await readPriorDoc(env, POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH);
  if (!prior?.body)
    return refuse(`no document at ${POLICY_SIGN_NAMESPACE}/${AUTO_MERGE_POLICY_PATH}.`);
  const body = editPolicy(splitSignedTask(prior.body).body, to, change, unit);
  // Parsed as the loader will parse it: an unknown class, money or a namespace the policy
  // does not cover refuses here, before anything is signed.
  const parsed = parseMergePolicy(body);
  if ("error" in parsed) return refuse(`the edited policy would not load: ${parsed.error}`);
  if (
    parsed.policy.version !== to ||
    parsed.policy.units.includes(unit) !== (change === "promote")
  ) {
    return refuse(
      "the edited policy does not say what the change asked for, so nothing is written. Edit the policy by hand.",
    );
  }
  return {
    ok: true,
    from,
    to,
    unit,
    change,
    body,
    prior: { title: prior.title, body: prior.body },
    changes: [
      `${POLICY_SIGN_NAMESPACE}/${AUTO_MERGE_POLICY_PATH}: version ${from} -> ${to}, signed. Version ${from} is snapshotted, and from now the loaders accept version ${to} and no older copy (the anti-rollback pin).`,
      change === "promote"
        ? `${unit} is added under ${UNITS_SECTION}: its pull requests may merge with no human when every other check passes. It widens only the allowed paths; refused paths, money, migrations and workflows still refuse.`
        : `${unit} is removed from ${UNITS_SECTION}: its pull requests wait for an approval again.`,
      `Type ${to} as confirm to sign it.`,
    ],
  };
}

/** The write: the plan again from the state now, the typed version checked, then signed. */
export async function performPolicyChange(
  env: Env,
  actor: string,
  change: string | undefined,
  rawUnit: string | undefined,
  confirm: string | undefined,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const plan = await planPolicyChange(env, change, rawUnit);
  if (!plan.ok) return plan;
  if (!confirm)
    return {
      ok: false,
      error: `sign_policy_change widens or narrows what merges with no human, so it needs the new version number typed as confirm: ${plan.to}.`,
    };
  if (confirm !== plan.to)
    return {
      ok: false,
      error: `confirm is '${confirm}', but the new version is ${plan.to}. Nothing was signed.`,
    };
  const committed = await commitSigned(
    env,
    "sign_policy_change",
    POLICY_SIGN_NAMESPACE,
    AUTO_MERGE_POLICY_PATH,
    plan.prior,
    plan.body,
    (signature, sha256, bytes) =>
      auditStatement(
        env.DB,
        actor,
        "policy-changed",
        POLICY_SIGN_NAMESPACE,
        AUTO_MERGE_POLICY_PATH,
        {
          from: plan.from,
          to: plan.to,
          change: plan.change,
          unit: plan.unit,
          signature,
          sha256,
          bytes,
        },
      ),
  );
  if (!committed.ok) return committed;
  return {
    ok: true,
    summary: `Signed auto-merge policy version ${plan.to}: ${plan.unit} ${plan.change === "promote" ? "promoted to auto" : "removed from auto"}.`,
  };
}
