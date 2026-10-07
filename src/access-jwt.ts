import { createRemoteJWKSet, customFetch, decodeProtectedHeader, errors, jwtVerify } from "jose";

// Verifies the ID token Cloudflare Access for SaaS (OIDC) returns at Capsid's login
// callback (capsid/research/design-capsid-access-login.md; decided 2026-09-27).
//
// Measured 2026-09-27 from the Capsid SaaS app's discovery document: the issuer is
// https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>, the keys are
// at <issuer>/jwks, and ID tokens are RS256. The signature, algorithm, iss, aud, exp and
// nbf are checked by jose (6.2.12, pinned), the standard the portfolio's sites share
// (centralize D3, capsid/research/centralize-build-jobs.md; carrel's verifier is the model).
// What jose does not decide is checked here, each with a named reason: the token names a
// kid, it carries this sign-in's nonce, email_verified is not false, and an email is
// present. Anything else is a refusal with a reason.
//
// Keys come through jose's createRemoteJWKSet, refetched when a token names an unknown kid
// (how a rotation is picked up). cooldownDuration is 0 so that refetch is immediate, as
// the hand-rolled verifier this replaced did, and cacheMaxAge is the hour it used. The
// resolver is kept per JWKS URL.

const KEYS_TTL_MS = 60 * 60 * 1000;
const ALLOWED_ALGORITHMS = ["RS256"];

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
}

export type KeysFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

export interface IdTokenCheck {
  issuer: string;
  clientId: string;
  jwksUrl: string;
  nonce: string;
}

export type IdTokenVerdict = { ok: true; email: string } | { ok: false; reason: string };

type KeyResolver = ReturnType<typeof createRemoteJWKSet>;

// What went wrong reading the keys, kept beside the resolver: jose reports a failed fetch
// in its own words, and the reason Capsid shows names the fetch's own message.
interface Keys {
  resolve: KeyResolver;
  lastError: { current: Error | null };
}

const resolvers = new Map<string, Keys>();

export function clearIdTokenKeysCache(): void {
  resolvers.clear();
}

function keysFor(url: string, fetchKeys: KeysFetcher | null): Keys {
  const have = resolvers.get(url);
  if (have) return have;
  const lastError: { current: Error | null } = { current: null };
  const resolve = createRemoteJWKSet(new URL(url), {
    cooldownDuration: 0,
    cacheMaxAge: KEYS_TTL_MS,
    // The injected fetcher is how a test serves keys; live, jose's own fetch reads the URL.
    ...(fetchKeys
      ? {
          [customFetch]: async (target: string): Promise<Response> => {
            try {
              const fetched = await fetchKeys(target);
              if (!fetched || !Array.isArray(fetched.keys)) throw new Error("the Access JWKS endpoint returned no keys array");
              return Response.json(fetched);
            } catch (err) {
              lastError.current = err instanceof Error ? err : new Error(String(err));
              throw lastError.current;
            }
          },
        }
      : {}),
  });
  const made = { resolve, lastError };
  resolvers.set(url, made);
  return made;
}

const brief = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 120);

export async function verifyIdToken(token: string, check: IdTokenCheck, now: Date, fetchKeys: KeysFetcher | null = null): Promise<IdTokenVerdict> {
  // The kid is required before jose is asked: a token with no kid would otherwise match
  // whichever single key the endpoint serves, and the endpoint's key set is not the
  // token's to choose.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "the ID token is not a JWT or does not decode" };
  }
  if (typeof header.kid !== "string" || header.kid === "") {
    // An alg other than RS256 is the more useful thing to say when both are wrong.
    if (header.alg !== "RS256") return { ok: false, reason: `the ID token's alg is ${String(header.alg)}, not RS256` };
    return { ok: false, reason: "the ID token names no kid" };
  }

  const keys = keysFor(check.jwksUrl, fetchKeys);
  keys.lastError.current = null;
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, keys.resolve, {
      algorithms: ALLOWED_ALGORITHMS,
      issuer: check.issuer,
      audience: check.clientId,
      currentDate: now,
      requiredClaims: ["exp"],
    }));
  } catch (err) {
    if (keys.lastError.current) return { ok: false, reason: `the Access keys could not be read: ${brief(keys.lastError.current)}` };
    if (err instanceof errors.JOSEAlgNotAllowed) return { ok: false, reason: `the ID token's alg is ${String(header.alg)}, not RS256` };
    if (err instanceof errors.JWSSignatureVerificationFailed) return { ok: false, reason: "the ID token's signature does not verify" };
    if (err instanceof errors.JWKSNoMatchingKey) return { ok: false, reason: `no Access key has kid ${header.kid}` };
    if (err instanceof errors.JWTExpired) return { ok: false, reason: "the ID token has expired or carries no exp" };
    if (err instanceof errors.JWTClaimValidationFailed) {
      switch (err.claim) {
        case "iss":
          return { ok: false, reason: "iss is not this application's issuer" };
        case "aud":
          return { ok: false, reason: "aud does not hold this application's client id" };
        case "exp":
          return { ok: false, reason: "the ID token has expired or carries no exp" };
        case "nbf":
          return { ok: false, reason: "the ID token is not valid yet (nbf)" };
        default:
          return { ok: false, reason: `the ID token's ${String(err.claim)} claim is not acceptable` };
      }
    }
    if (err instanceof errors.JWSInvalid || err instanceof errors.JWTInvalid) return { ok: false, reason: "the ID token is not a JWT or does not decode" };
    return { ok: false, reason: `the signature could not be checked: ${brief(err)}` };
  }

  if (payload.nonce !== check.nonce) return { ok: false, reason: "the ID token's nonce is not this sign-in's" };
  if (payload.email_verified === false) return { ok: false, reason: "the ID token says the email is not verified" };
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email) return { ok: false, reason: "the ID token carries no email" };
  return { ok: true, email };
}
