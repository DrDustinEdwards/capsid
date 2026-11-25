import { SELF } from "cloudflare:test";

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BENCH_KEY = "integration-bench-secret-not-a-real-one";

/** A signed POST to the bench endpoints; `key` overrides the signing key for a wrong-key test. */
export async function post(path: string, body: Record<string, unknown>, key = BENCH_KEY) {
  const text = JSON.stringify({ jti: crypto.randomUUID(), ...body });
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return SELF.fetch(`https://capsid.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bench-Timestamp": ts,
      "X-Bench-Signature": await hmacHex(key, `${ts}.${text}`),
    },
    body: text,
  });
}
