import assert from "node:assert/strict";
import { test } from "node:test";
import { b64url, encryptPayload, fromB64url, readVapidKey, sendPush, subscriptionProblem, vapidJwt } from "../src/web-push.ts";

// Web Push from the Worker (docs/design/design-merge-pipeline.md section 5, PR 7). The
// encryption is checked against RFC 8291's worked example (Appendix A) byte for byte, and
// against a receiver written here from the RFC for a fresh key and salt. The VAPID JWT is
// checked by verifying its signature with the public half.

// RFC 8291, Appendix A.
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

function jwkOf(d: string, publicKey: string): JsonWebKey {
  const p = fromB64url(publicKey);
  return { kty: "EC", crv: "P-256", d, x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)) };
}

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const SUB = { endpoint: ENDPOINT, p256dh: UA_PUBLIC, auth: AUTH };

/** The user agent's side of RFC 8291, written from the RFC: what a browser does. */
async function decrypt(body: Uint8Array, uaJwk: JsonWebKey, uaPublic: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  assert.equal(rs, 4096);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  const priv = await crypto.subtle.importKey("jwk", uaJwk, ecdh, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPublic, ecdh, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm, priv, 256));
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hk(auth, shared, info, 32);
  const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  assert.equal(padded[end], 2, "the last record's delimiter is 2");
  return new TextDecoder().decode(padded.slice(0, end));
}

test("the body matches RFC 8291's worked example byte for byte", async () => {
  const body = await encryptPayload(SUB, new TextEncoder().encode(PLAINTEXT), { privateJwk: jwkOf(AS_PRIVATE, AS_PUBLIC), salt: fromB64url(SALT) });
  assert.equal(b64url(body), BODY);
});

test("a fresh key and salt decrypt to the payload on the receiving side", async () => {
  const body = await encryptPayload(SUB, new TextEncoder().encode('{"kind":"rollback"}'));
  assert.notEqual(b64url(body.slice(0, 16)), SALT, "the salt is fresh");
  const text = await decrypt(body, jwkOf(UA_PRIVATE, UA_PUBLIC), fromB64url(UA_PUBLIC), fromB64url(AUTH));
  assert.equal(text, '{"kind":"rollback"}');
});

test("a payload that does not fit one record is refused", async () => {
  await assert.rejects(encryptPayload(SUB, new Uint8Array(4096)), /does not fit/);
});

test("the VAPID key is read from its JWK, and a broken secret says why", () => {
  assert.match(readVapidKey(undefined) as string, /not set/);
  assert.match(readVapidKey("nope") as string, /not JSON/);
  assert.match(readVapidKey(JSON.stringify({ kty: "RSA" })) as string, /P-256/);
  const key = readVapidKey(JSON.stringify(jwkOf(AS_PRIVATE, AS_PUBLIC)));
  assert.ok(typeof key !== "string");
  assert.equal(key.publicKey, AS_PUBLIC);
});

test("the VAPID JWT verifies with the public key and names the push service's origin", async () => {
  const key = readVapidKey(JSON.stringify(jwkOf(AS_PRIVATE, AS_PUBLIC)));
  assert.ok(typeof key !== "string");
  const now = new Date("2026-10-11T12:00:00Z");
  const jwt = await vapidJwt(key, "https://fcm.googleapis.com", "mailto:admin@example.com", now);
  const [h, c, s] = jwt.split(".");
  const pub = await crypto.subtle.importKey("raw", fromB64url(AS_PUBLIC), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(s!), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok, "the signature verifies");
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(c!)));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:admin@example.com");
  assert.equal(claims.exp, Math.floor(now.getTime() / 1000) + 12 * 3600);
});

test("only a known push service's https endpoint with well-formed keys is accepted", () => {
  assert.equal(subscriptionProblem(SUB), null);
  assert.equal(subscriptionProblem({ ...SUB, endpoint: "https://web.push.apple.com/abc" }), null);
  assert.match(subscriptionProblem({ ...SUB, endpoint: "http://fcm.googleapis.com/x" })!, /not https/);
  assert.match(subscriptionProblem({ ...SUB, endpoint: "https://evil.example.com/x" })!, /not a known push service/);
  assert.match(subscriptionProblem({ ...SUB, endpoint: "https://fcm.googleapis.com.evil.example/x" })!, /not a known push service/);
  assert.match(subscriptionProblem({ ...SUB, p256dh: AUTH })!, /p256dh/);
  assert.match(subscriptionProblem({ ...SUB, auth: UA_PUBLIC })!, /auth/);
  assert.match(subscriptionProblem({ endpoint: "not a url" })!, /not a URL/);
});

test("sendPush posts the encrypted body with the VAPID header, and a 410 says the subscription is gone", async () => {
  const key = readVapidKey(JSON.stringify(jwkOf(AS_PRIVATE, AS_PUBLIC)));
  assert.ok(typeof key !== "string");
  const seen: { url: string; init: RequestInit }[] = [];
  const answer = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! });
    return new Response(null, { status });
  }) as typeof fetch;
  const ok = await sendPush(key, "mailto:admin@example.com", SUB, { kind: "rollback" }, new Date(), answer(201));
  assert.deepEqual(ok, { status: 201, gone: false });
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(seen[0]!.url, ENDPOINT);
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.match(headers.Authorization!, new RegExp(`^vapid t=[^,]+, k=${AS_PUBLIC}$`));
  const text = await decrypt(seen[0]!.init.body as Uint8Array, jwkOf(UA_PRIVATE, UA_PUBLIC), fromB64url(UA_PUBLIC), fromB64url(AUTH));
  assert.deepEqual(JSON.parse(text), { kind: "rollback" });
  assert.deepEqual(await sendPush(key, "mailto:a@example.com", SUB, {}, new Date(), answer(410)), { status: 410, gone: true });
  assert.deepEqual(await sendPush(key, "mailto:a@example.com", SUB, {}, new Date(), answer(404)), { status: 404, gone: true });
  const thrown = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.deepEqual(await sendPush(key, "mailto:a@example.com", SUB, {}, new Date(), thrown), { status: 0, gone: false });
});
