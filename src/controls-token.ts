import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { hmacHex } from "./auth";
import { isPortalAction, UNKNOWN_ACTION } from "./controls-base";
import { b64urlEncode, b64urlDecode } from "./encoding";
import type { Env } from "./env";
import type { PortalAction } from "./ops-types/portal";

// The confirmation token: base64url of the canonical claims, a dot, and the hex
// HMAC-SHA256 of that base64url text under the derived key.
interface ConfirmClaims {
  v: 2;
  // A one-time id: a perform spends it in KV, so a confirmation is used once, by whichever
  // surface took it (controls design, D2). Version 1 tokens had none and are retired.
  jti: string;
  action: PortalAction;
  params: Record<string, string>;
  email: string;
  exp: number;
}

// Its own context string, so this key differs from every other key derived from
// COOKIE_ENCRYPTION_KEY, and a version bump retires every outstanding token.
const TOKEN_CONTEXT = "capsid-portal-confirm:v2";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
const JTI_SHAPE = /^[0-9a-f]{32}$/;

function canonical(claims: ConfirmClaims): string {
  const params: Record<string, string> = {};
  for (const key of Object.keys(claims.params).sort()) params[key] = claims.params[key];
  return JSON.stringify({ v: claims.v, jti: claims.jti, action: claims.action, params, email: claims.email, exp: claims.exp });
}

async function confirmKey(env: Env): Promise<string> {
  // Fails closed: with no root secret there is nothing to sign with, and an empty key
  // would sign with a value anybody knows.
  if (!env.COOKIE_ENCRYPTION_KEY) throw new Error("COOKIE_ENCRYPTION_KEY is unset, so no confirmation can be signed or checked");
  return hmacHex(env.COOKIE_ENCRYPTION_KEY, TOKEN_CONTEXT);
}

export async function signConfirm(env: Env, claims: ConfirmClaims): Promise<string> {
  const payload = b64urlEncode(canonical(claims));
  return `${payload}.${await hmacHex(await confirmKey(env), payload)}`;
}

type Verified = { ok: true; claims: ConfirmClaims } | { ok: false; status: number; refusal: string };

export async function verifyConfirm(env: Env, token: string, email: string, now: Date): Promise<Verified> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, status: 403, refusal: "the confirmation token is malformed: preview again." };
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  if (!await safeEqual(token.slice(dot + 1), await hmacHex(await confirmKey(env), payload))) {
    return { ok: false, status: 403, refusal: "the confirmation token does not verify: preview again." };
  }
  let claims: ConfirmClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload)) as ConfirmClaims;
  } catch (err) {
    // Signed by this Worker and unreadable: a defect, said so.
    return { ok: false, status: 403, refusal: `the confirmation token verifies but does not parse (${err instanceof Error ? err.message : String(err)}): preview again.` };
  }
  const paramsOk =
    claims && typeof claims.params === "object" && claims.params !== null && Object.values(claims.params).every((v) => typeof v === "string");
  if (claims?.v !== 2 || typeof claims.jti !== "string" || !JTI_SHAPE.test(claims.jti) || typeof claims.email !== "string" || typeof claims.exp !== "number" || !paramsOk) {
    return { ok: false, status: 403, refusal: "the confirmation token verifies but its claims are not the shape this Worker signs: preview again." };
  }
  if (claims.email !== email) return { ok: false, status: 403, refusal: "the confirmation was issued to another session: preview again." };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, status: 410, refusal: "the confirmation expired: preview again." };
  if (!isPortalAction(claims.action)) return { ok: false, status: 400, refusal: UNKNOWN_ACTION(String(claims.action)) };
  return { ok: true, claims };
}
