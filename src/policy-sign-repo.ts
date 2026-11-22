// sign_policy_from_repo: sign the policy as the repo file stands.
import { commitSigned, POLICY_SIGN_NAMESPACE, readPriorDoc } from "./policy-sign";
import type { Env } from "./env";

import { splitSignedTask } from "./signed-docs";
import { auditStatement } from "./store-guards";
import { AUTO_MERGE_POLICY_PATH, checkMergePolicyBody } from "./auto-merge-policy";
import { parseMergePolicy } from "./auto-merge-policy-parse";
import { readRepoFile } from "./github/contents";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

import { errorMessage } from "@dustinedwards/site-runtime/log";

// sign_policy_from_repo: the reviewable source of the auto-merge policy is docs/policy/auto-merge.md on the default branch, and the stored, signed copy is written from it in one admin step. The preview reads the file from GitHub, holds it to checkMergePolicyBody and shows the old and new hash and the differing lines. The perform reads it again, refuses if it is not the text the preview showed, then writes and signs it through commitSigned. The version number typed as confirm is the version in the file. The stored policy in force need not load: this is also the way to replace one that does not.

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
  const surplus = (
    source: string,
    own: Map<string, number>,
    against: Map<string, number>,
  ): string[] => {
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
  const more =
    real.length > SHOWN_LINES ? [`... and ${real.length - SHOWN_LINES} more ${label} lines.`] : [];
  return [...real.slice(0, SHOWN_LINES).map((l) => `${mark} ${l}`), ...more];
}

/** What sign_policy_from_repo will write: the repo's file now against the stored policy.
 *  Reads only. */
export async function planPolicyFromRepo(env: Env): Promise<RepoPolicyPlan> {
  const refuse = (error: string): RepoPolicyPlan => ({ ok: false, error });
  if (!env.IMPROVE_SCORE_SECRET)
    return refuse(
      "signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no policy can be signed.",
    );
  let content: string;
  try {
    // Fresh, not the read cache: the perform compares this read with the preview's.
    content = (
      await readRepoFile(env, POLICY_SIGN_NAMESPACE, REPO_POLICY_PATH, undefined, undefined, true)
    ).content;
  } catch (err) {
    return refuse(
      `${REPO_POLICY_PATH} could not be read from the ${POLICY_SIGN_NAMESPACE} repo's default branch, so nothing is signed: ${errorMessage(err)}`,
    );
  }
  if (splitSignedTask(content).signature !== null || content.startsWith("---\n")) {
    return refuse(
      `${REPO_POLICY_PATH} opens with frontmatter. The repo file is the unsigned source, and the signature is added here, so nothing is signed.`,
    );
  }
  if (content.trim().length === 0)
    return refuse(
      `${REPO_POLICY_PATH} is empty. An empty policy authorizes nothing and is not signed.`,
    );
  // The checks the loader makes, so what is signed here is a body the Worker will load.
  const loaded = checkMergePolicyBody(content);
  if ("error" in loaded)
    return refuse(`${REPO_POLICY_PATH} would not load, so nothing is signed: ${loaded.error}`);
  const to = loaded.policy.version;
  if (!/^[1-9][0-9]{0,5}$/.test(to))
    return refuse(
      `${REPO_POLICY_PATH} says version '${to}', not a whole number, so the version to type as confirm cannot be named.`,
    );

  const prior = await readPriorDoc(env, POLICY_SIGN_NAMESPACE, AUTO_MERGE_POLICY_PATH);
  if (!prior?.body) {
    return refuse(
      `no document at ${POLICY_SIGN_NAMESPACE}/${AUTO_MERGE_POLICY_PATH} to write over. Write it once with capsid_write_doc (allow_improve_paths), and this control keeps it in step with the repo.`,
    );
  }
  const stored = splitSignedTask(prior.body).body;
  const storedParsed = parseMergePolicy(stored);
  const from = "policy" in storedParsed ? storedParsed.policy.version : null;
  const oldSha = await sha256Hex(stored);
  const newSha = await sha256Hex(content);
  if (oldSha === newSha)
    return refuse(`${REPO_POLICY_PATH} is the policy already stored, so there is nothing to sign.`);
  // Two different documents under one version number would muddle the history. The pin
  // keeps a rollback out of the loaders, but not that.
  if (from !== null && /^[1-9][0-9]{0,5}$/.test(from) && Number(to) <= Number(from)) {
    return refuse(
      `${REPO_POLICY_PATH} says version ${to}, and the stored policy is version ${from}. Raise the version in the file before signing it.`,
    );
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
export async function performPolicyFromRepo(
  env: Env,
  actor: string,
  confirm: string | undefined,
  previewedSha: string | undefined,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if (!previewedSha)
    return {
      ok: false,
      error:
        "sign_policy_from_repo carries the hash its preview read, and this confirmation has none. Nothing was signed. Preview again.",
    };
  const plan = await planPolicyFromRepo(env);
  if (!plan.ok) return plan;
  if (plan.newSha !== previewedSha) {
    return {
      ok: false,
      error: `${REPO_POLICY_PATH} changed since the preview (it read ${previewedSha}; it now reads ${plan.newSha}). Nothing was signed. Preview again.`,
    };
  }
  if (!confirm)
    return {
      ok: false,
      error: `sign_policy_from_repo changes what merges with no human, so it needs the version number typed as confirm: ${plan.to}.`,
    };
  if (confirm !== plan.to)
    return {
      ok: false,
      error: `confirm is '${confirm}', but the file's version is ${plan.to}. Nothing was signed.`,
    };
  const committed = await commitSigned(
    env,
    "sign_policy_from_repo",
    POLICY_SIGN_NAMESPACE,
    AUTO_MERGE_POLICY_PATH,
    plan.prior,
    plan.body,
    (signature, sha256, bytes) =>
      auditStatement(
        env.DB,
        actor,
        "policy-loaded-from-repo",
        POLICY_SIGN_NAMESPACE,
        AUTO_MERGE_POLICY_PATH,
        {
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
        },
      ),
  );
  if (!committed.ok) return committed;
  return {
    ok: true,
    summary: `Signed auto-merge policy version ${plan.to} from ${REPO_POLICY_PATH} (${plan.removed.length} lines removed, ${plan.added.length} added).`,
  };
}
