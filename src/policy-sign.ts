import type { Env } from "./env";
import { sha256Hex } from "./auth";
import { POLICY_PREFIX, policyPin, policyPinKey, signTaskBody, splitSignedTask } from "./signed-docs";
import { auditStatement, documentUpsert, isMissingRowAbort, requireBodyUnchanged, snapshotLive } from "./store-guards";
import { AUTO_MERGE_POLICY_PATH, checkMergePolicyBody, loadMergePolicy, parseMergePolicy } from "./auto-merge-policy";
import { readRepoFile } from "./github/contents";

// Signing a policy document: the one path that mints the signature the auto-merge and
// gate policies are verified against. Its constraints:
//
//   1. Admin only, enforced at the tool layer: an agent that could sign a policy could
//      widen itself.
//   2. capsid/policy/ only, checked here as well as at the tool, so no second caller
//      can point it elsewhere.
//   3. It signs what is already stored. There is no body argument, so this cannot sign
//      arbitrary bytes.
//   4. It re-signs rather than nesting: existing frontmatter is stripped first.
//
// The write snapshots the prior row and appends to audit_log in one batch
// (test/write-invariants.test.ts).

export interface PolicySignResult {
  ok: true;
  action: "sign_policy";
  namespace: string;
  path: string;
  signature: string;
  // Of the signed body as stored.
  sha256: string;
  bytes: number;
  resigned: boolean;
}

export interface PolicySignRefusal {
  ok: false;
  action: "sign_policy";
  error: string;
}

const POLICY_SIGN_NAMESPACE = "capsid";

export async function signPolicyDocument(
  env: Env,
  actor: string,
  namespace: string,
  path: string
): Promise<PolicySignResult | PolicySignRefusal> {
  const refuse = (error: string): PolicySignRefusal => ({ ok: false, action: "sign_policy", error });

  if (namespace !== POLICY_SIGN_NAMESPACE) {
    return refuse(
      `sign_policy only signs documents in '${POLICY_SIGN_NAMESPACE}', and this asked for '${namespace}'. The policies this Worker reads live in one namespace.`
    );
  }
  if (!path.startsWith(POLICY_PREFIX) || path.includes("..")) {
    return refuse(
      `sign_policy only signs documents under '${POLICY_PREFIX}', and this asked for '${path}'. A signature is authority, so the set of paths that can carry one is fixed.`
    );
  }
  if (!env.IMPROVE_SCORE_SECRET) {
    return refuse("signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no policy can be signed.");
  }

  const prior = await env.DB.prepare("SELECT title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ title: string | null; body: string | null }>();
  if (!prior) {
    return refuse(`no document at ${namespace}/${path}. Write the policy first, read it, then sign it.`);
  }

  const stored = prior.body ?? "";
  const { signature: existing, body } = splitSignedTask(stored);
  if (body.trim().length === 0) {
    return refuse(`${namespace}/${path} has an empty body below its frontmatter. An empty policy authorises nothing and is not signed.`);
  }
  const committed = await commitSigned(env, "sign_policy", namespace, path, prior, body, (sig, sha, bytes) =>
    // The signature and hash, not the body, which the document and snapshot hold.
    auditStatement(env.DB, actor, "policy-signed", namespace, path, { signature: sig, sha256: sha, bytes, resigned: existing !== null })
  );
  if (!committed.ok) return refuse(committed.error);
  const { signature, sha256, signed } = committed;

  return {
    ok: true,
    action: "sign_policy",
    namespace,
    path,
    signature: signature ?? "",
    sha256,
    bytes: signed.length,
    resigned: existing !== null,
  };
}

/** Sign `body` and write it over the stored policy at `path`: the anti-rollback pin first,
 *  then one batch that refuses if the stored body changed since `prior` was read,
 *  snapshots the prior row, writes the signed body and the audit row
 *  (test/write-invariants.test.ts). */
async function commitSigned(
  env: Env,
  caller: string,
  namespace: string,
  path: string,
  prior: { title: string | null; body: string | null },
  body: string,
  audit: (signature: string | null, sha256: string, bytes: number) => D1PreparedStatement
): Promise<{ ok: true; signed: string; signature: string | null; sha256: string } | { ok: false; error: string }> {
  const signed = await signTaskBody(env.IMPROVE_SCORE_SECRET!, body);
  const { signature } = splitSignedTask(signed);
  const sha256 = await sha256Hex(signed);
  // The anti-rollback record is written first: from here on the loaders accept this
  // body and no other signed copy (policyPin in signed-docs.ts). Written before the
  // store so every failure refuses, including a store that aborts below.
  try {
    await env.APP_KV.put(policyPinKey(path), JSON.stringify(await policyPin(body)));
  } catch (err) {
    return {
      ok: false,
      error: `the anti-rollback record for ${namespace}/${path} could not be written (${err instanceof Error ? err.message : String(err)}). Nothing was signed or written. Sign it again.`,
    };
  }
  // The body guard goes first, so an edit after the read aborts rather than being
  // replaced by the signed older body.
  try {
    await env.DB.batch([
      requireBodyUnchanged(env.DB, namespace, path, prior.body),
      snapshotLive(env.DB, namespace, path),
      documentUpsert(env.DB, namespace, path, prior.title, signed, null, null, null),
      audit(signature, sha256, signed.length),
    ]);
  } catch (err) {
    if (isMissingRowAbort(err)) {
      // The pin above already moved, so the message says so: until the next signing the
      // loaders accept only the body read here, not whatever the document holds now.
      return {
        ok: false,
        error:
          `${namespace}/${path} changed or was removed after ${caller} read it, so the document was not written. ` +
          `Its anti-rollback record (${policyPinKey(path)}) already names the body ${caller} read, so the stored policy does not load until it is signed again. ` +
          `Read the policy again and sign it again.`,
      };
    }
    throw err;
  }
  return { ok: true, signed, signature, sha256 };
}

// ---------------------------------------------------------------------------
// sign_policy_change (docs/design/design-merge-pipeline.md section 7, PR 10; Dustin's
// DECIDE 9 of 2026-10-09): promoting a merge unit to auto, or removing one, writes the
// next version of the auto-merge policy and signs it in one admin control. It widens
// autonomy, so the perform needs the new version number typed as confirm. It edits only
// two things in the stored, signed policy: the version line, and one line of the
// `## Auto units` section. The new body must load as the old one did (the same checks,
// paths and steps the code enforces), or nothing is written.

type PolicyChange = "promote" | "demote";

export type PolicyChangePlan =
  | { ok: true; from: string; to: string; unit: string; change: PolicyChange; body: string; prior: { title: string | null; body: string }; changes: string[] }
  | { ok: false; error: string };

const UNITS_SECTION = "## Auto units";
const UNITS_INTRO = "Merge units promoted to auto by a signed policy change (sign_policy_change), each a namespace and a path class. A unit widens only the namespace's allowed paths; refused paths, money, migrations and workflows still refuse.";

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
  if (head < 0) return `${lines.join("\n").replace(/\s*$/, "")}\n\n${UNITS_SECTION}\n\n${UNITS_INTRO}\n\n${line}\n`;
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
export async function planPolicyChange(env: Env, change: string | undefined, rawUnit: string | undefined): Promise<PolicyChangePlan> {
  const refuse = (error: string): PolicyChangePlan => ({ ok: false, error });
  if (change !== "promote" && change !== "demote") return refuse(`sign_policy_change needs change: promote or demote; got '${change ?? ""}'.`);
  const unit = normalUnit(rawUnit);
  if (!unit) return refuse(`sign_policy_change needs unit as '<namespace>/<path class>', for example 'capsid/tests'; got '${rawUnit ?? ""}'.`);
  if (!env.IMPROVE_SCORE_SECRET) return refuse("signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no policy can be signed.");
  // The policy in force must load first: a change is made to a policy the Worker trusts.
  const loaded = await loadMergePolicy(env);
  if ("error" in loaded) return refuse(`the auto-merge policy in force does not load, so it is not changed: ${loaded.error}`);
  const from = loaded.policy.version;
  if (!/^[1-9][0-9]{0,5}$/.test(from)) return refuse(`the policy's version is '${from}', not a whole number, so its next version cannot be named.`);
  const to = String(Number(from) + 1);
  const listed = loaded.policy.units.includes(unit);
  if (change === "promote" && listed) return refuse(`${unit} is already promoted to auto in version ${from}.`);
  if (change === "demote" && !listed) return refuse(`${unit} is not promoted to auto in version ${from}, so there is nothing to remove.`);
  const prior = await env.DB.prepare("SELECT title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH)
    .first<{ title: string | null; body: string | null }>();
  if (!prior?.body) return refuse(`no document at ${POLICY_SIGN_NAMESPACE}/${AUTO_MERGE_POLICY_PATH}.`);
  const body = editPolicy(splitSignedTask(prior.body).body, to, change, unit);
  // Parsed as the loader will parse it: an unknown class, money or a namespace the policy
  // does not cover refuses here, before anything is signed.
  const parsed = parseMergePolicy(body);
  if ("error" in parsed) return refuse(`the edited policy would not load: ${parsed.error}`);
  if (parsed.policy.version !== to || parsed.policy.units.includes(unit) !== (change === "promote")) {
    return refuse("the edited policy does not say what the change asked for, so nothing is written. Edit the policy by hand.");
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
export async function performPolicyChange(env: Env, actor: string, change: string | undefined, rawUnit: string | undefined, confirm: string | undefined): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const plan = await planPolicyChange(env, change, rawUnit);
  if (!plan.ok) return plan;
  if (!confirm) return { ok: false, error: `sign_policy_change widens or narrows what merges with no human, so it needs the new version number typed as confirm: ${plan.to}.` };
  if (confirm !== plan.to) return { ok: false, error: `confirm is '${confirm}', but the new version is ${plan.to}. Nothing was signed.` };
  const committed = await commitSigned(env, "sign_policy_change", POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH, plan.prior, plan.body, (signature, sha256, bytes) =>
    auditStatement(env.DB, actor, "policy-changed", POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH, { from: plan.from, to: plan.to, change: plan.change, unit: plan.unit, signature, sha256, bytes })
  );
  if (!committed.ok) return committed;
  return { ok: true, summary: `Signed auto-merge policy version ${plan.to}: ${plan.unit} ${plan.change === "promote" ? "promoted to auto" : "removed from auto"}.` };
}

// ---------------------------------------------------------------------------
// sign_policy_from_repo: the reviewable source of the auto-merge policy is
// docs/policy/auto-merge.md on the default branch, and the stored, signed copy is written
// from it. This control does that in one admin step instead of a capsid_write_doc and a
// sign_policy by hand. The preview reads the file from GitHub, holds it to the checks
// loadMergePolicy makes (checkMergePolicyBody) and shows the old and new hash and the
// lines that differ. The perform reads it again and refuses if it is not the text the
// preview showed, then writes and signs it through commitSigned. It widens or narrows
// autonomy as the document says, so the version number typed as confirm is the version in
// the file. The stored policy in force need not load: this is also the way to replace one
// that does not.

/** The reviewable source, on the capsid repo's default branch. */
export const REPO_POLICY_PATH = "docs/policy/auto-merge.md";

export type RepoPolicyPlan =
  | {
      ok: true;
      // The stored policy's version, or null when what is stored has no readable version.
      from: string | null;
      to: string;
      // Of the unsigned body stored now, and of the file in the repo.
      oldSha: string;
      newSha: string;
      body: string;
      prior: { title: string | null; body: string };
      added: string[];
      removed: string[];
      changes: string[];
    }
  | { ok: false; error: string };

const SHOWN_LINES = 12;

/** The lines each text has that the other lacks, as a multiset: order is not compared, which
 *  is enough to say how much changed and to show a reader what. */
function lineDelta(before: string, after: string): { added: string[]; removed: string[] } {
  const count = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of text.split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  // The lines of `source` beyond the number `against` has of each.
  const surplus = (source: string, own: Map<string, number>, against: Map<string, number>): string[] => {
    const out: string[] = [];
    const seen = new Map<string, number>();
    for (const l of source.split("\n")) {
      const n = (seen.get(l) ?? 0) + 1;
      seen.set(l, n);
      if (n > (against.get(l) ?? 0) && n <= (own.get(l) ?? 0)) out.push(l);
    }
    return out;
  };
  return { added: surplus(after, b, a), removed: surplus(before, a, b) };
}

function shownLines(label: "added" | "removed", lines: string[]): string[] {
  const real = lines.filter((l) => l.trim().length > 0);
  const mark = label === "added" ? "+" : "-";
  const more = real.length > SHOWN_LINES ? [`... and ${real.length - SHOWN_LINES} more ${label} lines.`] : [];
  return [...real.slice(0, SHOWN_LINES).map((l) => `${mark} ${l}`), ...more];
}

/** What sign_policy_from_repo will write: the repo's file now against the stored policy.
 *  Reads only. */
export async function planPolicyFromRepo(env: Env): Promise<RepoPolicyPlan> {
  const refuse = (error: string): RepoPolicyPlan => ({ ok: false, error });
  if (!env.IMPROVE_SCORE_SECRET) return refuse("signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no policy can be signed.");
  let content: string;
  try {
    // Fresh, not the read cache: the perform compares this read with the preview's.
    content = (await readRepoFile(env, POLICY_SIGN_NAMESPACE, REPO_POLICY_PATH, undefined, undefined, true)).content;
  } catch (err) {
    return refuse(`${REPO_POLICY_PATH} could not be read from the ${POLICY_SIGN_NAMESPACE} repo's default branch, so nothing is signed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (splitSignedTask(content).signature !== null || content.startsWith("---\n")) {
    return refuse(`${REPO_POLICY_PATH} opens with frontmatter. The repo file is the unsigned source, and the signature is added here, so nothing is signed.`);
  }
  if (content.trim().length === 0) return refuse(`${REPO_POLICY_PATH} is empty. An empty policy authorises nothing and is not signed.`);
  // The checks the loader makes, so what is signed here is a body the Worker will load.
  const loaded = checkMergePolicyBody(content);
  if ("error" in loaded) return refuse(`${REPO_POLICY_PATH} would not load, so nothing is signed: ${loaded.error}`);
  const to = loaded.policy.version;
  if (!/^[1-9][0-9]{0,5}$/.test(to)) return refuse(`${REPO_POLICY_PATH} says version '${to}', not a whole number, so the version to type as confirm cannot be named.`);

  const prior = await env.DB.prepare("SELECT title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH)
    .first<{ title: string | null; body: string | null }>();
  if (!prior?.body) {
    return refuse(`no document at ${POLICY_SIGN_NAMESPACE}/${AUTO_MERGE_POLICY_PATH} to write over. Write it once with capsid_write_doc (allow_improve_paths), and this control keeps it in step with the repo.`);
  }
  const stored = splitSignedTask(prior.body).body;
  const storedParsed = parseMergePolicy(stored);
  const from = "policy" in storedParsed ? storedParsed.policy.version : null;
  const oldSha = await sha256Hex(stored);
  const newSha = await sha256Hex(content);
  if (oldSha === newSha) return refuse(`${REPO_POLICY_PATH} is the policy already stored, so there is nothing to sign.`);
  // Two different documents under one version number would muddle the history. The pin
  // keeps a rollback out of the loaders, but not that.
  if (from !== null && /^[1-9][0-9]{0,5}$/.test(from) && Number(to) <= Number(from)) {
    return refuse(`${REPO_POLICY_PATH} says version ${to}, and the stored policy is version ${from}. Raise the version in the file before signing it.`);
  }
  const { added, removed } = lineDelta(stored, content);
  return {
    ok: true,
    from,
    to,
    oldSha,
    newSha,
    body: content,
    prior: { title: prior.title, body: prior.body },
    added,
    removed,
    changes: [
      `${POLICY_SIGN_NAMESPACE}/${AUTO_MERGE_POLICY_PATH}: ${from === null ? "the stored body has no readable version" : `version ${from}`} -> ${to}, written exactly as ${REPO_POLICY_PATH} reads on the default branch now, and signed. The stored version is snapshotted, and from now the loaders accept this body and no older copy (the anti-rollback pin).`,
      `sha256 of the body: ${oldSha} (stored) -> ${newSha} (repo).`,
      `Lines changed: ${removed.length} removed, ${added.length} added.`,
      ...shownLines("removed", removed),
      ...shownLines("added", added),
      `Type ${to} as confirm to sign it. The perform reads the file again and is refused if it is not this text.`,
    ],
  };
}

/** The write: the file read again and checked against the preview's hash, the typed version
 *  checked, then signed through commitSigned. */
export async function performPolicyFromRepo(env: Env, actor: string, confirm: string | undefined, previewedSha: string | undefined): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if (!previewedSha) return { ok: false, error: "sign_policy_from_repo carries the hash its preview read, and this confirmation has none. Nothing was signed. Preview again." };
  const plan = await planPolicyFromRepo(env);
  if (!plan.ok) return plan;
  if (plan.newSha !== previewedSha) {
    return { ok: false, error: `${REPO_POLICY_PATH} changed since the preview (it read ${previewedSha}; it now reads ${plan.newSha}). Nothing was signed. Preview again.` };
  }
  if (!confirm) return { ok: false, error: `sign_policy_from_repo changes what merges with no human, so it needs the version number typed as confirm: ${plan.to}.` };
  if (confirm !== plan.to) return { ok: false, error: `confirm is '${confirm}', but the file's version is ${plan.to}. Nothing was signed.` };
  const committed = await commitSigned(env, "sign_policy_from_repo", POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH, plan.prior, plan.body, (signature, sha256, bytes) =>
    auditStatement(env.DB, actor, "policy-loaded-from-repo", POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH, {
      from: plan.from,
      to: plan.to,
      source: REPO_POLICY_PATH,
      old_sha256: plan.oldSha,
      new_sha256: plan.newSha,
      added: plan.added.length,
      removed: plan.removed.length,
      signature,
      sha256,
      bytes,
    })
  );
  if (!committed.ok) return committed;
  return { ok: true, summary: `Signed auto-merge policy version ${plan.to} from ${REPO_POLICY_PATH} (${plan.removed.length} lines removed, ${plan.added.length} added).` };
}
