import type { Env } from "./env";
import { sha256Hex } from "./auth";
import { POLICY_PREFIX } from "./improve-schema";
import { policyPin, policyPinKey, signTaskBody, splitSignedTask } from "./improve-task";
import { auditStatement, documentUpsert, isMissingRowAbort, requireBodyUnchanged, snapshotLive } from "./store-guards";

// ---- signing a policy document ------------------------------------------------
//
// THE ONE THING THAT MINTS POLICY AUTHORITY, and the narrowest surface that can do
// the job. The auto-merge policy and the gate policy are both verified with
// verifySignedBody, and until this existed nothing could produce the signature they
// verify: signTaskBody was reachable only from the improve loop's run-document writer
// and from jobs post. Both policies were inert by construction.
//
// FOUR CONSTRAINTS, and each is here because this function decides what the machine
// may do without a human:
//
//   1. ADMIN ONLY. Enforced at the tool layer, on the same reasoning as `agents`: a
//      minted agent that could sign a policy could write itself a policy that widened
//      it, which is an agent with no scope.
//   2. ONE NAMESPACE AND ONE PREFIX. capsid/policy/ and nothing else. The path is
//      checked here rather than only at the tool, because this is the function whose
//      output is authority and a second caller must not be able to point it elsewhere.
//   3. IT SIGNS WHAT IS ALREADY STORED. There is no body argument. A caller cannot
//      hand this function bytes to sign: it signs the document the store holds, which
//      is the document a human wrote and can read back. Signing supplied bytes would
//      make this an oracle for signing anything.
//   4. IT RE-SIGNS RATHER THAN NESTING. An already-signed document has its frontmatter
//      stripped before signing, so signing twice is idempotent in shape and the second
//      signature covers the same bytes as the first.
//
// The write goes through the same invariants every other write does: the prior row is
// snapshotted into document_versions and a row is appended to audit_log, in one batch.

export interface PolicySignResult {
  ok: true;
  action: "sign_policy";
  namespace: string;
  path: string;
  signature: string;
  // Of the SIGNED body as stored, so a caller can verify the write without reading
  // the document back.
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

  // THE ANTI-ROLLBACK RECORD IS WRITTEN FIRST (audit 2026-09-25, E2-2). From here on
  // the loaders accept this body and no other signed copy (improve-task.ts, policyPin).
  // Written before the store so every failure refuses: a record that could not be
  // written stops the signing with nothing stored, and a store that aborts below
  // leaves the record naming a body that is not stored, which the loaders refuse
  // until the policy is signed again, as that refusal already asks.
  try {
    await env.APP_KV.put(policyPinKey(path), JSON.stringify(await policyPin(body)));
  } catch (err) {
    return refuse(
      `the anti-rollback record for ${namespace}/${path} could not be written (${err instanceof Error ? err.message : String(err)}). Nothing was signed or written. Sign it again.`
    );
  }

  // The body guard goes first. The signature covers the body read above, so a policy
  // edit that lands between that read and this batch must abort the signing: without
  // the guard the upsert would replace the newer policy with the signed older one.
  try {
    await env.DB.batch([
      requireBodyUnchanged(env.DB, namespace, path, prior.body),
      snapshotLive(env.DB, namespace, path),
      documentUpsert(env.DB, namespace, path, prior.title, signed, null, null, null),
      // The signature and the hash, not the body. What a reader of the log needs is
      // which bytes were blessed and when, and the bytes themselves are in the
      // document and its version snapshot.
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
