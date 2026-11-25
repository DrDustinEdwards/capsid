import { hmacSha256Hex } from "@dustinedwards/site-runtime/encoding";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { deriveTaskKey } from "./signed-docs";

// Text written before this carries no signature and is reported "legacy-unsigned", never verified:
// re-signing it now would put today's key on whatever it holds today, which a signature must not
// vouch for.

export type JobTextKind = "resume-note" | "summary";

export type SignatureCheck =
  | "verified"
  // Written before signing existed, or by a writer that does not sign: shown, labeled.
  | "legacy-unsigned"
  // A signature is present and does not match: the text or the signature was changed.
  | "mismatch"
  // IMPROVE_SCORE_SECRET is unset, so nothing can be checked.
  | "unconfigured";

function payload(kind: JobTextKind, jobId: string, fields: Record<string, string | null>): string {
  // Keys in a fixed order, so the same fields always produce the same bytes.
  const ordered = Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]]),
  );
  return `capsid-job-${kind}:v1\n${jobId}\n${JSON.stringify(ordered)}`;
}

export async function signJobText(
  rootSecret: string | undefined,
  kind: JobTextKind,
  jobId: string,
  fields: Record<string, string | null>,
): Promise<string | null> {
  if (!rootSecret) return null;
  return hmacSha256Hex(await deriveTaskKey(rootSecret), payload(kind, jobId, fields));
}

export async function checkJobText(
  rootSecret: string | undefined,
  kind: JobTextKind,
  jobId: string,
  fields: Record<string, string | null>,
  signature: string | null | undefined,
): Promise<SignatureCheck> {
  if (!signature) return "legacy-unsigned";
  if (!rootSecret) return "unconfigured";
  const expected = await hmacSha256Hex(
    await deriveTaskKey(rootSecret),
    payload(kind, jobId, fields),
  );
  return (await safeEqual(signature.toLowerCase(), expected)) ? "verified" : "mismatch";
}
