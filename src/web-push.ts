// WEB PUSH, SENT FROM THE WORKER (docs/design/design-merge-pipeline.md section 5, PR 7;
// Dustin's DECIDE 5 of 2026-10-09: Web Push, because his phone is Android). Nothing here
// knows what is being said or why: src/push.ts decides that. This module encrypts one
// payload for one browser subscription (RFC 8291, aes128gcm) and signs the request to its
// push service with the VAPID key (RFC 8292), with WebCrypto only, so no third party and
// no dependency is added.
//
// The VAPID key is one secret, VAPID_PRIVATE_KEY: a P-256 private key as a JWK (its x and
// y are the public half, which the Portal hands the browser when it subscribes).
// scripts/vapid-keys.mjs makes one and puts it with wrangler without printing it.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKey {
  jwk: JsonWebKey;
  /** The public key, 65 bytes uncompressed, base64url: what the browser subscribes with. */
  publicKey: string;
}

const RECORD_SIZE = 4096;
const TTL_SECONDS = 24 * 60 * 60;
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

// The push services a subscription may name. The Worker POSTs to the endpoint the browser
// gave, so an endpoint anywhere else is refused before it is stored: a stored endpoint is
// a URL the Worker will call every time something is urgent.
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Why a subscription cannot be stored, or null. Checked at subscribe time, before any
 *  row is written, and again before each send. */
export function subscriptionProblem(sub: Partial<PushSubscriptionKeys>): string | null {
  if (typeof sub.endpoint !== "string" || sub.endpoint.length > 1024) return "the subscription has no endpoint.";
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return "the subscription's endpoint is not a URL.";
  }
  if (url.protocol !== "https:") return "the subscription's endpoint is not https.";
  if (!PUSH_HOSTS.some((h) => h.test(url.hostname))) return `the subscription's endpoint is on ${url.hostname}, which is not a known push service.`;
  try {
    if (typeof sub.p256dh !== "string" || fromB64url(sub.p256dh).length !== 65) return "the subscription's p256dh key is not a 65-byte P-256 point.";
    if (typeof sub.auth !== "string" || fromB64url(sub.auth).length !== 16) return "the subscription's auth secret is not 16 bytes.";
  } catch {
    return "the subscription's keys are not base64url.";
  }
  return null;
}

/** The VAPID key from its secret, or why it cannot be used. */
export function readVapidKey(secret: string | undefined): VapidKey | string {
  if (!secret) return "VAPID_PRIVATE_KEY is not set, so no push can be signed (docs/portal.md, \"Phone alerts\").";
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(secret) as JsonWebKey;
  } catch {
    return "VAPID_PRIVATE_KEY is not JSON: it must be a P-256 private key as a JWK.";
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) return "VAPID_PRIVATE_KEY is not a P-256 private key as a JWK (kty EC, crv P-256, d, x and y).";
  const point = concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y));
  if (point.length !== 65) return "VAPID_PRIVATE_KEY's x and y are not 32 bytes each.";
  return { jwk: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, publicKey: b64url(point) };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The sender's half of one message: a fresh ECDH key pair and salt, or fixed ones in a
 *  test that checks RFC 8291's worked example. */
export interface Ephemeral {
  privateJwk?: JsonWebKey;
  salt?: Uint8Array;
}

/** RFC 8291: the aes128gcm body for one subscription, a single record. */
export async function encryptPayload(sub: PushSubscriptionKeys, plaintext: Uint8Array, fixed: Ephemeral = {}): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed.privateJwk) {
    asPrivate = await crypto.subtle.importKey("jwk", fixed.privateJwk, ecdh, false, ["deriveBits"]);
    asPublic = concat(new Uint8Array([4]), fromB64url(fixed.privateJwk.x!), fromB64url(fixed.privateJwk.y!));
  } else {
    const pair = (await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  // The standard member is `public`; workers-types spells it `$public` only because the
  // word is reserved in its generator, and workerd reads `public`.
  const derive = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(derive, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  // One record, so the delimiter is 2 (the last record) and no padding follows it.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error(`a push payload of ${plaintext.length} bytes does not fit one ${RECORD_SIZE}-byte record`);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

/** RFC 8292: the Authorization header's JWT for one push service origin. */
export async function vapidJwt(vapid: VapidKey, audience: string, subject: string, now: Date): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(utf8(JSON.stringify({ aud: audience, exp: Math.floor(now.getTime() / 1000) + JWT_LIFETIME_SECONDS, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is r || s, which is JWS's ES256 form already.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`)));
  return `${header}.${claims}.${b64url(sig)}`;
}

export interface PushSent {
  status: number;
  /** The push service says the subscription is gone (404 or 410): stop sending to it. */
  gone: boolean;
}

/** Encrypt and send one payload to one subscription. Never throws on a push service's
 *  answer; a network error is returned as status 0. */
export async function sendPush(
  vapid: VapidKey,
  subject: string,
  sub: PushSubscriptionKeys,
  payload: unknown,
  now: Date,
  fetcher: typeof fetch = fetch
): Promise<PushSent> {
  const problem = subscriptionProblem(sub);
  if (problem) return { status: 0, gone: true };
  const body = await encryptPayload(sub, utf8(JSON.stringify(payload)));
  const jwt = await vapidJwt(vapid, new URL(sub.endpoint).origin, subject, now);
  try {
    const res = await fetcher(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(TTL_SECONDS),
        Urgency: "high",
      },
      body,
    });
    await res.body?.cancel();
    return { status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { status: 0, gone: false };
  }
}
