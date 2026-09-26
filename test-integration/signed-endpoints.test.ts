import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REPORT_BYTES } from "../src/improve-scorer";

// The three HMAC endpoints end to end, against a real D1 and a real KV.
// /improve/score, /improve/holdout-credential and /backup/credential are the only
// write paths not behind OAuth. The key is derived from a root secret, the replay
// cache is an `INSERT ... ON CONFLICT DO NOTHING RETURNING` against a real PRIMARY
// KEY, and the run lookup is a real SELECT; only this layer proves SQLite accepts
// them and that the conflict conflicts.
//
// The keys are derived here the way the Worker derives them, from the same root the
// config binds, so a signature that verifies is not verifying against a stub.

const ROOT = "integration-root-secret-not-a-real-one";
const NAMESPACE = "capsid";

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

// The two derivations, spelled the way src/improve-scorer.ts spells them. A key
// derivation is a contract with other repos, so a changed context string fails here.
const scoreKey = (namespace: string) => hmacHex(ROOT, `capsid-improve-score:v1:${namespace}`);
const backupKey = () => hmacHex(ROOT, "capsid-backup-credential:v1");

async function post(path: string, key: string, body: unknown, overrides: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const signature = await hmacHex(key, `${ts}.${text}`);
  return SELF.fetch(`https://capsid.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Improve-Namespace": NAMESPACE,
      "X-Improve-Timestamp": ts,
      "X-Improve-Signature": signature,
      ...overrides,
    },
    body: text,
  });
}

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

const report = (jti: string, over: Record<string, unknown> = {}) => ({
  namespace: NAMESPACE,
  run_id: "shakedown",
  attempt_id: "integration",
  head_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  jti,
  anchors: { build_passes: 1 },
  secondary: { test_pass_rate: 1, lint_count: 0, bundle_size_bytes: 1000 },
  holdout: { total: 30, passed: 30 },
  ci_minutes: 1,
  ...over,
});

describe("/improve/score", () => {
  it("refuses an unsigned post before it looks anything up", async () => {
    const response = await SELF.fetch("https://capsid.test/improve/score", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Improve-Namespace": NAMESPACE },
      body: JSON.stringify(report("unsigned")),
    });
    // 400, not 401: a missing timestamp header is a malformed request rather than a
    // rejected credential.
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/timestamp header/);
  });

  it("refuses a WRONG signature with 401, which is the credential answer", async () => {
    const text = JSON.stringify(report(crypto.randomUUID()));
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const response = await SELF.fetch("https://capsid.test/improve/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Improve-Namespace": NAMESPACE,
        "X-Improve-Timestamp": ts,
        "X-Improve-Signature": "0".repeat(64),
      },
      body: text,
    });
    expect(response.status).toBe(401);
  });

  it("refuses a signature made with another namespace's key", async () => {
    // The per-namespace derivation makes a leaked key from one repo useless against
    // another.
    const response = await post("/improve/score", await scoreKey("foxing"), report("wrong-key"));
    expect(response.status).toBe(401);
  });

  it("verifies the signature and THEN refuses the unknown run, which is the shakedown contract", async () => {
    // 409 on run_id "shakedown" is the answer CI treats as success: it proves the
    // signature verified (a bad one is 401 before the lookup) and that the run
    // lookup ran against a real database.
    const response = await post("/improve/score", await scoreKey(NAMESPACE), report(crypto.randomUUID()));
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/unknown run/);
  });

  it("PLANT: a captured, still-in-window report cannot be replayed", async () => {
    // The replay cache is an INSERT ... ON CONFLICT DO NOTHING RETURNING against a
    // PRIMARY KEY; only a real table shows SQLite honours the conflict.
    const jti = crypto.randomUUID();
    const key = await scoreKey(NAMESPACE);
    const body = report(jti);
    const text = JSON.stringify(body);
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const signature = await hmacHex(key, `${ts}.${text}`);
    const send = () =>
      SELF.fetch("https://capsid.test/improve/score", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Improve-Namespace": NAMESPACE,
          "X-Improve-Timestamp": ts,
          "X-Improve-Signature": signature,
        },
        body: text,
      });

    const first = await send();
    expect(first.status).toBe(409);
    expect(await first.text()).toMatch(/unknown run/);

    // Byte-identical replay of a signature that is still inside its window.
    const second = await send();
    const secondText = await second.text();
    expect(second.status).not.toBe(200);
    expect(secondText).toMatch(/replay|already|jti/i);

    // The claim is in the table, so the refusal came from the replay cache.
    const claimed = await env.DB.prepare("SELECT COUNT(*) AS n FROM improve_jti WHERE jti = ?1").bind(jti).first<{ n: number }>();
    expect(claimed?.n).toBe(1);
  });

  it("refuses a timestamp outside the signature window", async () => {
    const key = await scoreKey(NAMESPACE);
    const text = JSON.stringify(report(crypto.randomUUID()));
    const stale = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString().replace(/\.\d+Z$/, "Z");
    const signature = await hmacHex(key, `${stale}.${text}`);
    const response = await SELF.fetch("https://capsid.test/improve/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Improve-Namespace": NAMESPACE,
        "X-Improve-Timestamp": stale,
        "X-Improve-Signature": signature,
      },
      body: text,
    });
    expect(response.status).toBe(401);
  });
});

describe("the two credential endpoints", () => {
  it("/improve/holdout-credential verifies the per-namespace key and fails on configuration, not on auth", async () => {
    const response = await post("/improve/holdout-credential", await scoreKey(NAMESPACE), {
      namespace: NAMESPACE,
      jti: crypto.randomUUID(),
    });
    // No R2 temp-credential secrets are bound here, so the mint cannot succeed. A 401
    // would mean the key derivation is wrong; a 500 naming the missing configuration
    // means the signature verified.
    expect(response.status).not.toBe(401);
    expect(await response.text()).toMatch(/not configured|R2_TEMP_CRED/);
  });

  it("/improve/holdout-credential refuses a request signed with the BACKUP key", async () => {
    // The holdout parent must not be able to read backups and vice versa, so a key
    // that works on one endpoint must not work on the other.
    const response = await post("/improve/holdout-credential", await backupKey(), {
      namespace: NAMESPACE,
      jti: crypto.randomUUID(),
    });
    expect(response.status).toBe(401);
  });

  it("/backup/credential refuses a request signed with a SCORE key", async () => {
    const response = await backupPost(await scoreKey(NAMESPACE), { jti: crypto.randomUUID() });
    expect(response.status).toBe(401);
  });

  it("/backup/credential accepts its own key and fails on configuration", async () => {
    const response = await backupPost(await backupKey(), { jti: crypto.randomUUID() });
    expect(response.status).not.toBe(401);
    expect(await response.text()).toMatch(/not configured|R2_TEMP_CRED/);
  });

  it("/backup/credential reads its OWN header names, which are not the improve ones", async () => {
    // Two mint paths with separate header contracts: X-Improve-Timestamp here is a
    // 400, not a 401.
    const wrongHeaders = await post("/backup/credential", await backupKey(), { jti: crypto.randomUUID() });
    expect(wrongHeaders.status).toBe(400);
    expect(await wrongHeaders.text()).toMatch(/timestamp header/);
  });
});

describe("the refusal each signed endpoint returns", () => {
  // The three endpoints refuse an oversized body and a body naming the wrong namespace
  // in their own words, and a caller reads the words.
  const oversized = "x".repeat(MAX_REPORT_BYTES + 1);

  function streamed(path: string, text: string, headers: Record<string, string>) {
    // No Content-Length, so the size is only discovered by reading.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return SELF.fetch(`https://capsid.test${path}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  }

  it("/improve/score names the declared size when Content-Length is over the limit", async () => {
    const response = await post("/improve/score", await scoreKey(NAMESPACE), { pad: oversized });
    expect(response.status).toBe(413);
    expect(await response.text()).toMatch(new RegExp(`^report too large: [0-9]+ bytes exceeds ${MAX_REPORT_BYTES}$`));
  });

  it("/improve/score refuses an oversized streamed body without a declared size", async () => {
    const response = await streamed("/improve/score", oversized, { "Content-Type": "application/json", "X-Improve-Namespace": NAMESPACE });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(`report too large: exceeds ${MAX_REPORT_BYTES} bytes`);
  });

  it("the two credential mints refuse an oversized body as a request, not a report", async () => {
    const holdout = await streamed("/improve/holdout-credential", oversized, { "X-Improve-Namespace": NAMESPACE });
    expect(holdout.status).toBe(413);
    expect(await holdout.text()).toBe(`request too large: exceeds ${MAX_REPORT_BYTES} bytes`);
    const backup = await streamed("/backup/credential", oversized, {});
    expect(backup.status).toBe(413);
    expect(await backup.text()).toBe(`request too large: exceeds ${MAX_REPORT_BYTES} bytes`);
  });

  it("/improve/score refuses a report body naming another namespace than its key", async () => {
    const response = await post("/improve/score", await scoreKey(NAMESPACE), report(crypto.randomUUID(), { namespace: "foxing" }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(`the report body names namespace 'foxing' but it was signed with the key for '${NAMESPACE}'`);
  });

  it("/improve/holdout-credential refuses a request body naming another namespace than its key", async () => {
    const response = await post("/improve/holdout-credential", await scoreKey(NAMESPACE), { namespace: "foxing", jti: crypto.randomUUID() });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(`the request body names namespace 'foxing' but it was signed with the key for '${NAMESPACE}'`);
  });
});
