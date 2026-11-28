import type { Env } from "./env";

import {
  POLICY_PREFIX,
  policyPin,
  policyPinKey,
  signTaskBody,
  splitSignedTask,
} from "./signed-docs";
import {
  auditStatement,
  documentUpsert,
  isMissingRowAbort,
  requireBodyUnchanged,
  snapshotLive,
} from "./store-guards";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// Signing a policy document: the one path that mints the signature the gate policy is verified
// against. Its constraints: 1.

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

/** The document a signing rewrites, as it stands before the write. */
function readPriorDoc(
  env: Env,
  namespace: string,
  path: string,
): Promise<{ title: string | null; body: string | null } | null> {
  return env.DB.prepare("SELECT title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ title: string | null; body: string | null }>();
}
export async function signPolicyDocument(
  env: Env,
  actor: string,
  namespace: string,
  path: string,
  // The sha256 of the body below the frontmatter, as the caller read it. The switch
  // always passes it; the tests of the signing machinery leave it out.
  readSha256?: string,
): Promise<PolicySignResult | PolicySignRefusal> {
  const refuse = (error: string): PolicySignRefusal => ({
    ok: false,
    action: "sign_policy",
    error,
  });

  if (namespace !== POLICY_SIGN_NAMESPACE) {
    return refuse(
      `sign_policy only signs documents in '${POLICY_SIGN_NAMESPACE}', and this asked for '${namespace}'. The policies this Worker reads live in one namespace.`,
    );
  }
  if (!path.startsWith(POLICY_PREFIX) || path.includes("..")) {
    return refuse(
      `sign_policy only signs documents under '${POLICY_PREFIX}', and this asked for '${path}'. A signature is authority, so the set of paths that can carry one is fixed.`,
    );
  }
  if (!env.IMPROVE_SCORE_SECRET) {
    return refuse(
      "signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no policy can be signed.",
    );
  }

  const prior = await readPriorDoc(env, namespace, path);
  if (!prior) {
    return refuse(
      `no document at ${namespace}/${path}. Write the policy first, read it, then sign it.`,
    );
  }

  const stored = prior.body ?? "";
  const { signature: existing, body } = splitSignedTask(stored);
  if (body.trim().length === 0) {
    return refuse(
      `${namespace}/${path} has an empty body below its frontmatter. An empty policy authorizes nothing and is not signed.`,
    );
  }
  if (readSha256 !== undefined) {
    const now = await sha256Hex(body);
    if (now !== readSha256.toLowerCase())
      return refuse(
        `${namespace}/${path} is not the body you read: its sha256 below the frontmatter is ${now}, not ${readSha256}. Nothing was signed. Read it again and sign the bytes you checked.`,
      );
  }
  const committed = await commitSigned(
    env,
    "sign_policy",
    namespace,
    path,
    prior,
    body,
    (sig, sha, bytes) =>
      // The signature and hash, not the body, which the document and snapshot hold.
      auditStatement(env.DB, actor, "policy-signed", namespace, path, {
        signature: sig,
        sha256: sha,
        bytes,
        resigned: existing !== null,
      }),
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

// Sign `body` and write it over the stored policy at `path`: the anti-rollback pin first, then one
// batch that refuses if the stored body changed since `prior` was read, snapshots the prior row,
// writes the signed body and the audit row (test/write-invariants.test.ts).
async function commitSigned(
  env: Env,
  caller: string,
  namespace: string,
  path: string,
  prior: { title: string | null; body: string | null },
  body: string,
  audit: (signature: string | null, sha256: string, bytes: number) => D1PreparedStatement,
): Promise<
  | { ok: true; signed: string; signature: string | null; sha256: string }
  | { ok: false; error: string }
> {
  const signed = await signTaskBody(env.IMPROVE_SCORE_SECRET!, body);
  const { signature } = splitSignedTask(signed);
  const digest = await sha256Hex(signed);
  // The anti-rollback record is written first: from here on the loaders accept this
  // body and no other signed copy (policyPin in signed-docs.ts). Written before the
  // store so every failure refuses, including a store that aborts below.
  try {
    await env.APP_KV.put(policyPinKey(path), JSON.stringify(await policyPin(body)));
  } catch (err) {
    return {
      ok: false,
      error: `the anti-rollback record for ${namespace}/${path} could not be written (${errorMessage(err)}). Nothing was signed or written. Sign it again.`,
    };
  }
  // The body guard goes first, so an edit after the read aborts rather than being
  // replaced by the signed older body.
  try {
    await env.DB.batch([
      requireBodyUnchanged(env.DB, namespace, path, prior.body),
      snapshotLive(env.DB, namespace, path),
      documentUpsert(env.DB, namespace, path, prior.title, signed, null, null, null),
      audit(signature, digest, signed.length),
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
  return { ok: true, signed, signature, sha256: digest };
}
