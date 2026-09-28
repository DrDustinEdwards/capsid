import { vi } from "vitest";
import { cimdResponse } from "./cimd-stub";

// Cloudflare Access for SaaS, as the login callback reaches it: the token endpoint,
// answering with an ID token signed by a key made here, and the JWKS endpoint serving
// that key's public half. Matches the test bindings in vitest.config.ts.

export const ISSUER = "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/sample-client";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
)) as CryptoKeyPair;
const publicJwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "stub-kid" };

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const head = b64json({ alg: "RS256", kid: "stub-kid", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = b64json({ iss: ISSUER, aud: "sample-client", iat: now, exp: now + 300, ...claims });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

// Stubs fetch for one sign-in as `email`. The nonce is read from the authorization URL
// the flow sent the browser to, as Access would echo it. Returns the token requests'
// bodies so a test can read the PKCE verifier and redirect_uri sent.
export function stubAccess(email: string, authorizationUrl: string, extra: Record<string, unknown> = {}): URLSearchParams[] {
  const nonce = new URL(authorizationUrl).searchParams.get("nonce");
  const bodies: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/token`) {
      bodies.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({ id_token: await idToken({ email, nonce, ...extra }), token_type: "bearer" });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [publicJwk] });
    const cimd = cimdResponse(url);
    if (cimd) return cimd;
    throw new Error(`unexpected fetch in the sign-in: ${url}`);
  });
  return bodies;
}
