import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { hmacHex } from "./auth";
import type { Env } from "./env";
import { base64url, fromBase64url } from "@dustinedwards/site-runtime/encoding";

const decodeBase64url = (text: string): string => new TextDecoder().decode(fromBase64url(text));

// The namespace delete's confirmation token (src/namespace-delete.ts previews and
// performs the delete).

// Its own context string, so this key differs from the Portal's confirmation key and
// every other key derived from COOKIE_ENCRYPTION_KEY: a Portal token never verifies
// here. A version bump retires every outstanding token.
const TOKEN_CONTEXT = "capsid-namespace-delete:v1";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;

export interface DeleteClaims {
  v: 1;
  namespace: string;
  cascade: boolean;
  allow_improve_paths: boolean;
  actor: string;
  plan: string;
  exp: number;
}

function canonicalClaims(c: DeleteClaims): string {
  return JSON.stringify({
    v: c.v,
    namespace: c.namespace,
    cascade: c.cascade,
    allow_improve_paths: c.allow_improve_paths,
    actor: c.actor,
    plan: c.plan,
    exp: c.exp,
  });
}

async function tokenKey(env: Pick<Env, "COOKIE_ENCRYPTION_KEY">): Promise<string> {
  // Fails closed: with no root secret there is nothing to sign with, and an empty key
  // would sign with a value anybody knows.
  if (!env.COOKIE_ENCRYPTION_KEY) throw new Error("COOKIE_ENCRYPTION_KEY is unset, so no delete confirmation can be signed or checked");
  return hmacHex(env.COOKIE_ENCRYPTION_KEY, TOKEN_CONTEXT);
}

export async function signDeleteToken(env: Pick<Env, "COOKIE_ENCRYPTION_KEY">, claims: DeleteClaims): Promise<string> {
  const payload = base64url(canonicalClaims(claims));
  return `${payload}.${await hmacHex(await tokenKey(env), payload)}`;
}

export type Verified = { ok: true; claims: DeleteClaims } | { ok: false; refusal: string };

/** Checks the signature, the shape, the caller, the expiry and the arguments the token
 *  was signed for. The plan is compared by the caller after it re-reads it. */
export async function verifyDeleteToken(
  env: Pick<Env, "COOKIE_ENCRYPTION_KEY">,
  token: string,
  expect: { actor: string; namespace: string; cascade: boolean; allowImprovePaths: boolean },
  now: Date
): Promise<Verified> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, refusal: "the confirmation token is malformed: preview again." };
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  if (!await safeEqual(token.slice(dot + 1), await hmacHex(await tokenKey(env), payload))) {
    return { ok: false, refusal: "the confirmation token does not verify: preview again." };
  }
  let claims: DeleteClaims;
  try {
    claims = JSON.parse(decodeBase64url(payload)) as DeleteClaims;
  } catch (err) {
    // Signed by this Worker and unreadable: a defect, said so.
    return { ok: false, refusal: `the confirmation token verifies but does not parse (${err instanceof Error ? err.message : String(err)}): preview again.` };
  }
  if (
    claims?.v !== 1 ||
    typeof claims.namespace !== "string" ||
    typeof claims.cascade !== "boolean" ||
    typeof claims.allow_improve_paths !== "boolean" ||
    typeof claims.actor !== "string" ||
    typeof claims.plan !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, refusal: "the confirmation token verifies but its claims are not the shape this Worker signs: preview again." };
  }
  if (claims.actor !== expect.actor) return { ok: false, refusal: "the confirmation was issued to another caller: preview again." };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, refusal: "the confirmation expired: preview again." };
  if (claims.namespace !== expect.namespace) {
    return { ok: false, refusal: `the confirmation was issued for namespace ${claims.namespace}, not ${expect.namespace}: preview again.` };
  }
  if (claims.cascade !== expect.cascade) {
    return { ok: false, refusal: `the confirmation was issued with cascade ${claims.cascade}, and this call passes ${expect.cascade}: preview again with the arguments you mean.` };
  }
  if (claims.allow_improve_paths !== expect.allowImprovePaths) {
    return {
      ok: false,
      refusal: `the confirmation was issued with allow_improve_paths ${claims.allow_improve_paths}, and this call passes ${expect.allowImprovePaths}: preview again with the arguments you mean.`,
    };
  }
  return { ok: true, claims };
}
