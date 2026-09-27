import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { accessGate, ACCESS_JWT_HEADER, clearAccessCertsCache, isConsolePath, verifyAccessJwt, type Jwk } from "../src/access-jwt.ts";
import type { Env } from "../src/env.ts";

// The console's Cloudflare Access check. Tokens are real RS256 JWTs signed with a key
// pair made here; the "certs endpoint" serves its public half, as Access does.

const TEAM = "https://sample.cloudflareaccess.com";
const AUD = "sample-aud-tag";
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
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk), kid };
  return { privateKey: pair.privateKey, jwk };
}

const SIGNER = await keyPair("kid-1");
const OTHER = await keyPair("kid-1");

async function token(claims: Record<string, unknown>, opts: { header?: Record<string, unknown>; key?: CryptoKey } = {}): Promise<string> {
  const head = b64json({ alg: "RS256", kid: "kid-1", typ: "JWT", ...opts.header });
  const body = b64json({ iss: TEAM, aud: [AUD], exp: SECONDS + 300, iat: SECONDS, email: "admin@example.com", ...claims });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? SIGNER.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

let fetches: string[] = [];
const certs = (keys: Jwk[]) => async (url: string) => {
  fetches.push(url);
  return { keys };
};
const config = { teamDomain: TEAM, aud: AUD };

beforeEach(() => {
  clearAccessCertsCache();
  fetches = [];
});

test("a token Access signed for this application passes, and the certs come from the team domain", async () => {
  const verdict = await verifyAccessJwt(await token({}), config, NOW, certs([SIGNER.jwk]));
  assert.deepEqual(verdict, { ok: true, email: "admin@example.com" });
  assert.deepEqual(fetches, [`${TEAM}/cdn-cgi/access/certs`]);
});

test("aud may be a string as well as an array", async () => {
  assert.equal((await verifyAccessJwt(await token({ aud: AUD }), config, NOW, certs([SIGNER.jwk]))).ok, true);
});

for (const [name, make, reason] of [
  ["no token", async () => null, /no Cf-Access-Jwt-Assertion header/],
  ["not a JWT", async () => "abc.def", /not a JWT/],
  ["a signature from another key", async () => token({}, { key: OTHER.privateKey }), /signature does not verify/],
  ["another application's aud", async () => token({ aud: ["other-app"] }), /aud does not hold/],
  ["another team's iss", async () => token({ iss: "https://evil.cloudflareaccess.com" }), /iss is https:\/\/evil/],
  ["an expired token", async () => token({ exp: SECONDS - 1 }), /expired/],
  ["a token with no exp", async () => token({ exp: undefined }), /expired or carries no exp/],
  ["a token not valid yet", async () => token({ nbf: SECONDS + 60 }), /not valid yet/],
  ["alg none", async () => (await token({}, { header: { alg: "none" } })).replace(/\.[^.]+$/, "."), /alg is none/],
  ["HS256", async () => token({}, { header: { alg: "HS256" } }), /alg is HS256/],
  ["no kid", async () => token({}, { header: { kid: undefined } }), /names no kid/],
] as const) {
  test(`refused: ${name}`, async () => {
    const verdict = await verifyAccessJwt(await make(), config, NOW, certs([SIGNER.jwk]));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.match(verdict.reason, reason);
  });
}

test("an unknown kid refetches the certs once, which is how a rotation is picked up", async () => {
  const rotated = await keyPair("kid-2");
  let served: Jwk[] = [SIGNER.jwk];
  const fetcher = async (url: string) => {
    fetches.push(url);
    return { keys: served };
  };
  assert.equal((await verifyAccessJwt(await token({}), config, NOW, fetcher)).ok, true);
  served = [SIGNER.jwk, rotated.jwk];
  const next = await token({}, { header: { kid: "kid-2" }, key: rotated.privateKey });
  assert.equal((await verifyAccessJwt(next, config, NOW, fetcher)).ok, true);
  assert.equal(fetches.length, 2);
  // Cached now: a third check fetches nothing.
  assert.equal((await verifyAccessJwt(next, config, NOW, fetcher)).ok, true);
  assert.equal(fetches.length, 2);
});

test("certs that cannot be read fail closed", async () => {
  const verdict = await verifyAccessJwt(await token({}), config, NOW, async () => {
    throw new Error("certs endpoint down");
  });
  assert.deepEqual(verdict, { ok: false, reason: "the Access certs could not be read: certs endpoint down" });
});

const request = (headers: Record<string, string> = {}) => new Request("https://capsid.dustinedwards.info/console", { headers });
const envWith = (vars: Partial<Env>) => vars as Env;

test("the gate admits a valid token and refuses a missing one with 403", async () => {
  const env = envWith({ ACCESS_TEAM_DOMAIN: `${TEAM}/`, ACCESS_AUD: AUD });
  assert.equal(await accessGate(request({ [ACCESS_JWT_HEADER]: await token({}) }), env, NOW, certs([SIGNER.jwk])), null);
  const refused = await accessGate(request(), env, NOW, certs([SIGNER.jwk]));
  assert.equal(refused?.status, 403);
  assert.match(await refused!.text(), /only through Cloudflare Access: no Cf-Access-Jwt-Assertion header/);
});

test("an unconfigured gate closes the console with 503 rather than skipping the check", async () => {
  for (const env of [envWith({}), envWith({ ACCESS_TEAM_DOMAIN: TEAM }), envWith({ ACCESS_AUD: AUD })]) {
    const refused = await accessGate(request({ [ACCESS_JWT_HEADER]: await token({}) }), env, NOW, certs([SIGNER.jwk]));
    assert.equal(refused?.status, 503);
  }
});

// The router: every console dispatch line runs its handler through throughAccess, and
// no other line does. Parsed the way test/route-gates.test.ts parses defaultHandler.
test("every console route in defaultHandler goes through Access, and no other route does", () => {
  const routes = readFileSync(join(import.meta.dirname, "..", "src", "routes.ts"), "utf8");
  const body = routes.slice(routes.indexOf("export const defaultHandler"));
  const lines = [...body.matchAll(/url\.pathname === ("[^"]+"|[A-Z_]+)[^\n]*?\breturn (\w+)\(/g)].map((m) => ({ path: m[1], handler: m[2] }));
  const console = lines.filter((l) => /^(CONSOLE_[A-Z_]*PATH|"\/console[^"]*")$/.test(l.path));
  assert.equal(console.length, 4, `parsed ${console.length} console dispatch lines`);
  for (const l of console) assert.equal(l.handler, "throughAccess", `${l.path} is dispatched without the Access check`);
  for (const l of lines.filter((x) => !console.includes(x))) assert.notEqual(l.handler, "throughAccess", `${l.path} goes through Access`);
});

test("the console paths are exactly the four console routes' paths", () => {
  for (const p of ["/console", "/console.json", "/console/callback"]) assert.equal(isConsolePath(p), true, p);
  for (const p of ["/mcp", "/ops/mcp", "/health", "/authorize", "/callback", "/token", "/register", "/.well-known/oauth-authorization-server", "/consoles", "/"]) {
    assert.equal(isConsolePath(p), false, p);
  }
});
