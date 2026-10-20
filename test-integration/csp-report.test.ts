import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import worker, { BACKUP_CRON } from "../src/index";
import { checkRate, CSP_REPORT_LIMIT } from "../src/rate-limit";
import { REPORT_PREFIX } from "../src/security-headers";
import { MAX_REPORT_BYTES } from "@dustinedwards/site-runtime/csp-report";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /csp-report against the real runtime: site-runtime's shared receiver, behind
// Capsid's limiter. Every POST is answered 204 (an error status makes browsers send
// the report again), a body over the cap is never parsed, nothing is stored, and the
// logged line carries no query string.

const ORIGIN = "https://capsid.test";
const CAP = MAX_REPORT_BYTES;

function report(padding: string, page = `${ORIGIN}/probe`) {
  return JSON.stringify({
    "csp-report": {
      "document-uri": page,
      "effective-directive": "integration-probe",
      "blocked-uri": "https://example.com/probe",
      note: padding,
    },
  });
}

async function postReport(body: string, ip = "203.0.113.10") {
  return SELF.fetch(`${ORIGIN}/csp-report`, {
    method: "POST",
    headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": ip },
    body,
  });
}

const stored = async () => (await env.MEDIA.list({ prefix: REPORT_PREFIX })).objects.length;

// The receiver's lines, as console.log saw them.
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());
const violations = () => logged.filter((l) => l.includes('"event":"csp-violation"'));

describe("/csp-report logs a violation and stores nothing", () => {
  it("an ordinary report is 204, logged once with no query string, and nothing reaches R2", async () => {
    const before = await stored();
    const resp = await postReport(report("a real violation would say more than this", `${ORIGIN}/probe?token=sample-secret`));
    expect(resp.status).toBe(204);
    expect(await stored()).toBe(before);
    const lines = violations();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line.page).toBe(`${ORIGIN}/probe`);
    expect(line.blocked).toBe("https://example.com/probe");
    expect(lines[0]).not.toContain("sample-secret");
  });
});

describe("/csp-report bounds the body in bytes, before buffering it", () => {
  it("a body over the cap is answered 204 and never parsed", async () => {
    const body = report("x".repeat(CAP));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(204);
    expect(violations()).toHaveLength(0);
  });

  it("counts BYTES, not UTF-16 code units: a multi-byte body over the cap is not parsed", async () => {
    // Each of these is one code unit and three bytes: 24,000 bytes on the wire, over
    // the cap, while String#length reads 8,000.
    const body = report("あ".repeat(8_000));
    expect(body.length).toBeLessThan(CAP);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(204);
    expect(violations()).toHaveLength(0);
  });

  it("still logs a multi-byte body that is genuinely under the cap", async () => {
    // A cap that dropped all multi-byte input would pass the test above for the
    // wrong reason.
    const body = report("あ".repeat(200));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(204);
    expect(violations()).toHaveLength(1);
  });
});

describe("/csp-report is rate limited before it reads anything", () => {
  it("a limited caller gets 204, and its report is neither logged nor stored", async () => {
    const ip = "203.0.113.77";
    let verdict = await checkRate(env.APP_KV, ip, new Date(), CSP_REPORT_LIMIT);
    for (let i = 0; i < CSP_REPORT_LIMIT.perHour + 1 && verdict.allowed; i++) {
      verdict = await checkRate(env.APP_KV, ip, new Date(), CSP_REPORT_LIMIT);
    }
    expect(verdict.allowed, "the limiter never refused, so this test proves nothing").toBe(false);
    const before = await stored();

    const valid = await postReport(report("a limited caller"), ip);
    expect(valid.status).toBe(204);
    expect(violations()).toHaveLength(0);
    expect(await stored()).toBe(before);
  });
});

describe("a report the sink stored before 2026-10-20 is reaped by the backup cron", () => {
  // The sink no longer stores, but the prune still reaps what it left under the
  // prefix. A fresh and an aged report are seeded as the old sink keyed them.
  it("the aged copy is deleted and the fresh report is kept", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fresh = `${REPORT_PREFIX}${today}/sample-ray.json`;
    // Same key, dated 40 days ago: past the 30-day retention the prune applies.
    const agedDay = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const aged = fresh.replace(today, agedDay);
    expect(aged).not.toBe(fresh);
    await env.MEDIA.put(fresh, "{}");
    await env.MEDIA.put(aged, "{}");

    // The backup refuses every prune when the store looks empty or the pinned FTS probe
    // misses, so the probe document /health also reads is seeded first.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'conventions.md', 'Portfolio-wide conventions', 'Standing rules that apply across all projects.', 'procedural', 'published')`
    ).run();

    const ctx = createExecutionContext();
    await worker.scheduled?.({ cron: BACKUP_CRON, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    const after = (await env.MEDIA.list({ prefix: REPORT_PREFIX })).objects.map((o) => o.key);
    expect(after, "the prune did not reap an aged report the sink's prefix holds").not.toContain(aged);
    expect(after, "the prune reaped a fresh report").toContain(fresh);
  });
});
