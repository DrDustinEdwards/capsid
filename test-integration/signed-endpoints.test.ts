import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_REPORT_BYTES } from "../src/signed-requests";

// The backup credential endpoint end to end, against a real D1 and a real KV.
// /backup/credential is a write path not behind OAuth. The key is derived from a root
// secret and the replay cache is an `INSERT ... ON CONFLICT DO NOTHING RETURNING`
// against a real PRIMARY KEY; only this layer proves SQLite accepts it and that the
// conflict conflicts.
//
// The key is derived here the way the Worker derives it, from the same root the
// config binds, so a signature that verifies is not verifying against a stub.

const ROOT = "integration-root-secret-not-a-real-one";

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The derivation, spelled the way scripts/derive-backup-key.mjs spells it. A key
// derivation is a contract with other repos, so a changed context string fails here.
const backupKey = () => hmacHex(ROOT, "capsid-backup-credential:v1");
// A key from the same root under another context, which must not verify here.
const otherKey = () => hmacHex(ROOT, "capsid-other-credential:v1");

// /backup/credential reads X-Backup-Timestamp and X-Backup-Signature, not the
// X-Improve-* pair, which stops a captured improve request being replayed at the
// backup mint.
async function backupPost(key: string, body: unknown) {
  const text = JSON.stringify(body);
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signature = await hmacHex(key, `${ts}.${text}`);
  return SELF.fetch("https://capsid.test/backup/credential", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Backup-Timestamp": ts,
      "X-Backup-Signature": signature,
    },
    body: text,
  });
}

describe("/backup/credential", () => {
  it("refuses a request signed with another key derived from the same root", async () => {
    const response = await backupPost(await otherKey(), { jti: crypto.randomUUID() });
    expect(response.status).toBe(401);
  });

  it("accepts its own key and fails on configuration", async () => {
    const response = await backupPost(await backupKey(), { jti: crypto.randomUUID() });
    expect(response.status).not.toBe(401);
    expect(await response.text()).toMatch(/not configured|R2_TEMP_CRED/);
  });

  it("refuses an unknown site with 400 before it mints or spends the jti", async () => {
    const jti = crypto.randomUUID();
    const unknown = await backupPost(await backupKey(), { jti, site: "julieedwards" });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/names no known site/);
    // The jti was not claimed: the same jti with a pinned site gets past the replay
    // cache to the configuration failure.
    const known = await backupPost(await backupKey(), { jti, site: "foxing" });
    expect(known.status).not.toBe(401);
    expect(await known.text()).toMatch(/not configured|R2_TEMP_CRED/);
  });

  it("reads its OWN header names, so a request without them is a 400, not a 401", async () => {
    const text = JSON.stringify({ jti: crypto.randomUUID() });
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const response = await SELF.fetch("https://capsid.test/backup/credential", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Improve-Timestamp": ts,
        "X-Improve-Signature": await hmacHex(await backupKey(), `${ts}.${text}`),
      },
      body: text,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/timestamp header/);
  });

  it("refuses an oversized streamed body as a request too large", async () => {
    // No Content-Length, so the size is only discovered by reading.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(MAX_REPORT_BYTES + 1)));
        controller.close();
      },
    });
    const response = await SELF.fetch("https://capsid.test/backup/credential", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(`request too large: exceeds ${MAX_REPORT_BYTES} bytes`);
  });
});
