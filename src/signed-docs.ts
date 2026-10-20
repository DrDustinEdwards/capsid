import { hmacHex, sha256Hex } from "./auth";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import type { Env } from "./env";

// The Worker signs the documents it later acts on: a job's body (src/jobs-claim.ts) and
// the two autonomy policies (src/policy-sign.ts). One key, derived from
// IMPROVE_SCORE_SECRET under its own context string, distinct from the backup
// credential's (src/signed-requests.ts) on purpose.
//
// The context string keeps the improve loop's name, where this signing began: changing
// it would invalidate every signed job and policy already stored.
const TASK_KEY_CONTEXT = "capsid-improve-task:v1";

export async function deriveTaskKey(rootSecret: string): Promise<string> {
  return hmacHex(rootSecret, TASK_KEY_CONTEXT);
}

export const TASK_SIGNATURE_FIELD = "capsid-task-signature";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/**
 * Split a signed document into its frontmatter signature and the signed body.
 *
 * `strayLines` counts every frontmatter line other than the one signature line.
 * signTaskBody writes exactly one line there, and the HMAC does not cover the
 * frontmatter, so any other line is unsigned text sitting beside the signature.
 * verifySignedBody refuses a document that carries one.
 */
export function splitSignedTask(text: string): { signature: string | null; body: string; strayLines: number } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { signature: null, body: text, strayLines: 0 };
  const lines = match[1].split("\n").map((l) => l.trim());
  const line = lines.find((l) => l.startsWith(`${TASK_SIGNATURE_FIELD}:`));
  const strayLines = lines.length - (line === undefined ? 0 : 1);
  const body = text.slice(match[0].length);
  if (!line) return { signature: null, body, strayLines };
  return { signature: line.slice(`${TASK_SIGNATURE_FIELD}:`.length).trim(), body, strayLines };
}

/** Wrap a rendered task body in the frontmatter block carrying its signature. */
export async function signTaskBody(rootSecret: string, body: string): Promise<string> {
  const key = await deriveTaskKey(rootSecret);
  const signature = await hmacHex(key, body);
  return `---\n${TASK_SIGNATURE_FIELD}: ${signature}\n---\n${body}`;
}

// `body` is the text the signature covers. A caller that reads fields from a signed
// document parses this, never the stored text, because the stored text also holds
// the frontmatter and the frontmatter is not signed.
export type TaskVerification = { ok: true; body: string } | { ok: false; reason: string };

// The signature check. A job is posted by a human seat, so its audit actor is that seat
// and only the signature proves it went through `post`. One implementation for every
// caller, so they cannot drift on what "signed" means.
export async function verifySignedBody(
  rootSecret: string | undefined,
  stored: string,
  what: string
): Promise<TaskVerification> {
  if (!rootSecret) {
    return { ok: false, reason: `signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no ${what} can be verified. Refusing rather than executing an unverifiable plan.` };
  }
  const { signature, body, strayLines } = splitSignedTask(stored);
  if (!signature) {
    return {
      ok: false,
      reason: `this ${what} carries no ${TASK_SIGNATURE_FIELD} frontmatter line. The Worker signs every one it writes, so an unsigned one did not come from it. Refusing to execute it.`,
    };
  }
  if (strayLines > 0) {
    return {
      ok: false,
      reason: `this ${what}'s frontmatter holds ${strayLines} line(s) besides the ${TASK_SIGNATURE_FIELD} line. The signature does not cover the frontmatter and the Worker writes only that one line there, so the extra lines were added after signing. Refusing to execute it.`,
    };
  }
  const key = await deriveTaskKey(rootSecret);
  const expected = await hmacHex(key, body);
  if (!await safeEqual(signature.toLowerCase(), expected)) {
    return {
      ok: false,
      reason: `this ${what}'s ${TASK_SIGNATURE_FIELD} does not match its body. It was edited after the Worker wrote it. Refusing to execute it.`,
    };
  }
  return { ok: true, body };
}

// One reader for both signed policies (capsid/policy/auto-merge.md and gates.md). Both
// are read, verified and parsed the same way, so a fix to that path is made once. Each
// loader keeps only what differs: which document, and what its parsed lists must agree
// with. It lives beside the verifier so one refused-list entry covers both.
const POLICY_NAMESPACE = "capsid";

// Where the signed policies live. sign_policy signs nothing outside it.
export const POLICY_PREFIX = "policy/";

/**
 * The ordinary write tools refuse a policy document. The Worker reads them as
 * authority: capsid/policy/auto-merge.md says what it may merge with no human, and
 * capsid/policy/gates.md which blocked commands the seat may approve without one. So
 * a write here is a ruling, accepted only with allow_improve_paths (a name kept from
 * the improve loop, removed 2026-10-19), which needs can_touch_protected.
 */
export function policyWriteRefusal(namespace: string, path: string, allow: boolean): string | null {
  if (allow || !path.startsWith(POLICY_PREFIX)) return null;
  return `${namespace}/${path} is an autonomy policy document. It decides what this Worker may do without a human, so a write here is a ruling. Pass allow_improve_paths: true to write it anyway; the flag needs the can_touch_protected scope and is audit-logged.`;
}

/**
 * Read capsid/<path> and return the signed body, or a refusal. `ifAbsent` finishes
 * the sentence that reports a missing document ("so nothing is auto-merged").
 */
export async function readSignedPolicy(
  env: Pick<Env, "DB" | "IMPROVE_SCORE_SECRET" | "APP_KV">,
  path: string,
  what: string,
  ifAbsent: string
): Promise<{ body: string } | { error: string }> {
  const row = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_NAMESPACE, path)
    .first<{ body: string | null }>();
  if (!row) return { error: `no ${what} at ${POLICY_NAMESPACE}/${path}, so ${ifAbsent}.` };
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, row.body ?? "", what);
  if (!verdict.ok) return { error: verdict.reason };
  // The signed body only. The stored text also holds the unsigned frontmatter.
  const rollback = await checkPolicyPin(env, path, what, verdict.body);
  if (rollback) return { error: rollback };
  return { body: verdict.body };
}

// Anti-rollback. A signature proves the Worker signed these bytes once, not that they
// are current. Every signed version stays in document_versions, and `capsid_write_doc`
// action restore or a plain write can put an older one back with its signature still verifying. So APP_KV
// records, under policyPinKey(path), the sha256 of the current signed body (plus its
// `- version:` for the refusal text), and a load refuses any other signed body.
// The pin is the hash, not the version, because a lower version signed on purpose (the
// seat withdrawing a change) must hold, and a higher version put back after it must
// not. sign_policy writes it before storing the signed document, so the body it signs
// becomes the only one that loads; re-signing the same body writes the same hash. A
// load writes it only when no record exists yet, pinning the signed body stored then.
export const policyPinKey = (path: string): string => `policy:signed:${path}`;

export interface PolicyPin {
  sha256: string;
  version: string | null;
}

export async function policyPin(body: string): Promise<PolicyPin> {
  return { sha256: await sha256Hex(body), version: policyField(body, "version") };
}

/** A refusal when `body` is not the signed body recorded for `path`, or null. */
async function checkPolicyPin(
  env: Pick<Env, "APP_KV">,
  path: string,
  what: string,
  body: string
): Promise<string | null> {
  const current = await policyPin(body);
  const cannot = (step: string, err: unknown) =>
    `the ${what}'s anti-rollback record (${policyPinKey(path)}) could not be ${step} (${err instanceof Error ? err.message : String(err)}), so the stored policy is not shown to be the last one signed. Refusing rather than loading it.`;
  let raw: string | null;
  try {
    raw = await env.APP_KV.get(policyPinKey(path));
  } catch (err) {
    return cannot("read", err);
  }
  if (raw === null) {
    try {
      await env.APP_KV.put(policyPinKey(path), JSON.stringify(current));
    } catch (err) {
      return cannot("written", err);
    }
    return null;
  }
  let pinned: PolicyPin;
  try {
    pinned = JSON.parse(raw) as PolicyPin;
  } catch (err) {
    return cannot("parsed", err);
  }
  if (pinned.sha256 === current.sha256) return null;
  return `the stored ${what} (version ${current.version ?? "unnamed"}, body sha256 ${current.sha256.slice(0, 12)}) is signed but is not the one last signed (version ${pinned.version ?? "unnamed"}, body sha256 ${String(pinned.sha256).slice(0, 12)}). An older signed copy put back in place is refused. If this copy is meant to be current, sign it again with sign_policy.`;
}

/** The value of the first `- <name>: <value>` line in a policy body, or null. */
export function policyField(body: string, name: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`- ${name}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

// A check or class id: a backticked lowercase name at the head of a list item. Matching
// the backticks, not any list item, keeps the prose around the list out of the policy.
export const POLICY_ID_ITEM = /^- `([a-z_]+)`/;
