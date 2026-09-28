import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearIdTokenKeysCache, verifyIdToken, type Jwk } from "../src/access-jwt.ts";
import { adminGrantEmail, isAdminEmail } from "../src/auth.ts";

// The ID token Access for SaaS returns at the login callback. Tokens are real RS256
// JWTs signed with a key pair made here; the "JWKS endpoint" serves its public half.

const ISSUER = "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/sample-client";
const CLIENT = "sample-client";
const NONCE = "sign-in-nonce";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const SECONDS = Math.floor(NOW.getTime() / 1000);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  return { privateKey: pair.privateKey, jwk: { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk), kid } };
}

const SIGNER = await keyPair("kid-1");
const OTHER = await keyPair("kid-1");

async function token(claims: Record<string, unknown>, opts: { header?: Record<string, unknown>; key?: CryptoKey } = {}): Promise<string> {
  const head = b64json({ alg: "RS256", kid: "kid-1", typ: "JWT", ...opts.header });
  const body = b64json({ iss: ISSUER, aud: CLIENT, exp: SECONDS + 300, iat: SECONDS, nonce: NONCE, email: "admin@example.com", ...claims });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? SIGNER.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

let fetches: string[] = [];
const keys = (list: Jwk[]) => async (url: string) => {
  fetches.push(url);
  return { keys: list };
};
const check = { issuer: ISSUER, clientId: CLIENT, jwksUrl: `${ISSUER}/jwks`, nonce: NONCE };

beforeEach(() => {
  clearIdTokenKeysCache();
  fetches = [];
});

test("an ID token Access signed for this application and this sign-in passes, and names the email", async () => {
  assert.deepEqual(await verifyIdToken(await token({}), check, NOW, keys([SIGNER.jwk])), { ok: true, email: "admin@example.com" });
  assert.deepEqual(fetches, [`${ISSUER}/jwks`]);
});

test("aud may be an array holding the client id", async () => {
  assert.equal((await verifyIdToken(await token({ aud: ["other", CLIENT] }), check, NOW, keys([SIGNER.jwk]))).ok, true);
});

for (const [name, make, reason] of [
  ["not a JWT", async () => "abc.def", /not a JWT/],
  ["a signature from another key", async () => token({}, { key: OTHER.privateKey }), /signature does not verify/],
  ["another application's aud", async () => token({ aud: "other-client" }), /aud does not hold/],
  ["another issuer", async () => token({ iss: "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/other" }), /not this application's issuer/],
  ["an expired token", async () => token({ exp: SECONDS - 1 }), /expired/],
  ["a token with no exp", async () => token({ exp: undefined }), /expired or carries no exp/],
  ["a token not valid yet", async () => token({ nbf: SECONDS + 60 }), /not valid yet/],
  ["another sign-in's nonce", async () => token({ nonce: "someone-elses" }), /nonce is not this sign-in's/],
  ["no nonce", async () => token({ nonce: undefined }), /nonce is not this sign-in's/],
  ["email_verified false", async () => token({ email_verified: false }), /not verified/],
  ["no email", async () => token({ email: undefined }), /carries no email/],
  ["alg none", async () => (await token({}, { header: { alg: "none" } })).replace(/\.[^.]+$/, "."), /alg is none/],
  ["HS256", async () => token({}, { header: { alg: "HS256" } }), /alg is HS256/],
  ["no kid", async () => token({}, { header: { kid: undefined } }), /names no kid/],
] as const) {
  test(`refused: ${name}`, async () => {
    const verdict = await verifyIdToken(await make(), check, NOW, keys([SIGNER.jwk]));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, reason);
  });
}

test("an unknown kid refetches the keys once, which is how a rotation is picked up", async () => {
  const rotated = await keyPair("kid-2");
  let served: Jwk[] = [SIGNER.jwk];
  const fetcher = async (url: string) => {
    fetches.push(url);
    return { keys: served };
  };
  assert.equal((await verifyIdToken(await token({}), check, NOW, fetcher)).ok, true);
  served = [SIGNER.jwk, rotated.jwk];
  const next = await token({}, { header: { kid: "kid-2" }, key: rotated.privateKey });
  assert.equal((await verifyIdToken(next, check, NOW, fetcher)).ok, true);
  assert.equal(fetches.length, 2);
  assert.equal((await verifyIdToken(next, check, NOW, fetcher)).ok, true);
  assert.equal(fetches.length, 2, "a cached key was fetched again");
});

test("keys that cannot be read fail closed", async () => {
  const verdict = await verifyIdToken(await token({}), check, NOW, async () => {
    throw new Error("jwks endpoint down");
  });
  assert.deepEqual(verdict, { ok: false, reason: "the Access keys could not be read: jwks endpoint down" });
});

test("a grant passes /mcp only when its props carry the admin's email, so a GitHub-era grant signs in again", () => {
  const env = { ADMIN_EMAIL: "admin@example.com" };
  assert.equal(adminGrantEmail(env, { email: "admin@example.com" }), "admin@example.com");
  // The props every grant carried before the move to Access.
  assert.equal(adminGrantEmail(env, { id: 7, login: "DrDustinEdwards", name: "Admin" }), null);
  assert.equal(adminGrantEmail(env, { email: "someone@example.com" }), null);
  assert.equal(adminGrantEmail(env, { email: 7 }), null);
  assert.equal(adminGrantEmail(env, undefined), null);
  assert.equal(adminGrantEmail({}, { email: "admin@example.com" }), null);
});

test("the admin is ADMIN_EMAIL exactly: trimmed, never case-folded, and nobody when unset", () => {
  const env = { ADMIN_EMAIL: " admin@example.com " };
  assert.equal(isAdminEmail(env, "admin@example.com"), true);
  assert.equal(isAdminEmail(env, "Admin@example.com"), false);
  assert.equal(isAdminEmail(env, "admin@example.com.evil"), false);
  assert.equal(isAdminEmail({}, "admin@example.com"), false);
  assert.equal(isAdminEmail({ ADMIN_EMAIL: "  " }, ""), false);
});
