import type { Env } from "./env";
import { sha256Hex } from "./auth";
import { POLICY_PREFIX } from "./improve-schema";
import { policyPin, policyPinKey, signTaskBody, splitSignedTask } from "./improve-task";
import { auditStatement, documentUpsert, isMissingRowAbort, requireBodyUnchanged, snapshotLive } from "./store-guards";

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
// (CLAUDE.md, snapshot rule).

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
  const signed = await signTaskBody(env.IMPROVE_SCORE_SECRET, body);
  const { signature } = splitSignedTask(signed);
  const sha256 = await sha256Hex(signed);

  // The anti-rollback record is written first: from here on the loaders accept this
  // body and no other signed copy (policyPin in improve-task.ts). Written before the
  // store so every failure refuses, including a store that aborts below.
  try {
    await env.APP_KV.put(policyPinKey(path), JSON.stringify(await policyPin(body)));
  } catch (err) {
    return refuse(
      `the anti-rollback record for ${namespace}/${path} could not be written (${err instanceof Error ? err.message : String(err)}). Nothing was signed or written. Sign it again.`
    );
  }

  // The body guard goes first, so an edit after the read aborts rather than being
  // replaced by the signed older body.
  try {
    await env.DB.batch([
      requireBodyUnchanged(env.DB, namespace, path, prior.body),
      snapshotLive(env.DB, namespace, path),
      documentUpsert(env.DB, namespace, path, prior.title, signed, null, null, null),
      // The signature and hash, not the body, which the document and snapshot hold.
      auditStatement(env.DB, actor, "policy-signed", namespace, path, {
        signature,
        sha256,
        bytes: signed.length,
        resigned: existing !== null,
      }),
    ]);
  } catch (err) {
    if (isMissingRowAbort(err)) {
      return refuse(
        `${namespace}/${path} changed or was removed after sign_policy read it. Nothing was signed or written. Read the policy again and sign it again.`
      );
    }
    throw err;
  }

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
