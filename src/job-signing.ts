import { hmacHex, timingSafeEqual } from "./auth";
import { deriveTaskKey } from "./improve-task";

// Signed resume notes and block commands (job_9e602b31888f item 4, OWASP ASI07).
//
// A job body is signed at post and verified at claim, but what a job carries after that
// was plain text: the approval a resume hands the driver, and the command a block asks a
// person to run. Both now carry an HMAC under the same key as a job body, bound to the
// job id and to what kind of text it is, so a note cannot be moved to another job and a
// summary cannot pass as a note.
//
// Text written before this was signed carries no signature. It is reported as
// "legacy-unsigned", never as verified: re-signing it now would put today's key on
// whatever it holds today, which is exactly what a signature must not vouch for.

export type JobTextKind = "resume-note" | "summary";

export type SignatureCheck =
  // The signature matches the text and the job.
  | "verified"
  // Written before signing existed, or by a writer that does not sign: shown, labelled.
  | "legacy-unsigned"
  // A signature is present and does not match: the text or the signature was changed.
  | "mismatch"
  // IMPROVE_SCORE_SECRET is unset, so nothing can be checked.
  | "unconfigured";

function payload(kind: JobTextKind, jobId: string, fields: Record<string, string | null>): string {
  // Keys in a fixed order, so the same fields always produce the same bytes.
  const ordered = Object.fromEntries(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  return `capsid-job-${kind}:v1\n${jobId}\n${JSON.stringify(ordered)}`;
}

export async function signJobText(
  rootSecret: string | undefined,
  kind: JobTextKind,
  jobId: string,
  fields: Record<string, string | null>
): Promise<string | null> {
  if (!rootSecret) return null;
  return hmacHex(await deriveTaskKey(rootSecret), payload(kind, jobId, fields));
}

export async function checkJobText(
  rootSecret: string | undefined,
  kind: JobTextKind,
  jobId: string,
  fields: Record<string, string | null>,
  signature: string | null | undefined
): Promise<SignatureCheck> {
  if (!signature) return "legacy-unsigned";
  if (!rootSecret) return "unconfigured";
  const expected = await hmacHex(await deriveTaskKey(rootSecret), payload(kind, jobId, fields));
  return timingSafeEqual(signature.toLowerCase(), expected) ? "verified" : "mismatch";
}
