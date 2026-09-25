import { hmacHex, timingSafeEqual } from "./auth";

// Distinct from the score-report and backup-credential contexts on purpose.
// scripts/improve-derive-key.mjs must match; test/improve-derive-key.test.ts pins both.
export const TASK_KEY_CONTEXT = "capsid-improve-task:v1";

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

// THE SIGNATURE HALF, ON ITS OWN. verifyTaskDoc adds an actor check on top of this,
// because only the loop writes a run document. A JOB is signed by the same Worker
// and posted by a human seat, so its audit actor is that seat and the actor check
// does not apply: what proves a job body went through `post` is that this Worker's
// key signed it. One implementation of the signature check, two callers, so the two
// cannot drift on what "signed" means.
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
  if (!timingSafeEqual(signature.toLowerCase(), expected)) {
    return {
      ok: false,
      reason: `this ${what}'s ${TASK_SIGNATURE_FIELD} does not match its body. It was edited after the Worker wrote it. Refusing to execute it.`,
    };
  }
  return { ok: true, body };
}

// Two halves: HMAC of the body below the frontmatter, and last audit actor
// improve-loop. Unconfigured (no IMPROVE_SCORE_SECRET) is a refusal, not a skip.
export async function verifyTaskDoc(
  rootSecret: string | undefined,
  stored: string,
  actor: string | null,
  expectedActor: string
): Promise<TaskVerification> {
  if (!rootSecret) {
    return { ok: false, reason: "task signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so no task document can be verified. Refusing rather than executing an unverifiable plan." };
  }
  if (actor !== expectedActor) {
    return {
      ok: false,
      reason: `this task document was last written by '${actor ?? "(no audit row)"}', not '${expectedActor}'. Only the loop writes task documents; refusing to execute one something else authored.`,
    };
  }
  return verifySignedBody(rootSecret, stored, "task document");
}
