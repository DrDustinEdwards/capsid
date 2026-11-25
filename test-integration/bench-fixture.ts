import { SELF } from "cloudflare:test";
import { hmacSha256Hex } from "@dustinedwards/site-runtime/encoding";

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
      "X-Bench-Signature": await hmacSha256Hex(key, `${ts}.${text}`),
    },
    body: text,
  });
}
