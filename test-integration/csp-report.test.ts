import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import worker, { BACKUP_CRON } from "../src/index";
import { checkRate, CSP_REPORT_LIMIT } from "../src/rate-limit";
import { REPORT_PREFIX } from "../src/headers";
import { describe, expect, it } from "vitest";

// /csp-report's body cap, measured against the real runtime. The cap must count
// bytes, not UTF-16 code units, and must stop reading at the byte that crosses it
// rather than buffering the whole body first. This suite posts real bodies to the
// real handler in workerd.

const ORIGIN = "https://capsid.test";
const CAP = 16_384;

function report(padding: string) {
  return JSON.stringify({
    "csp-report": {
      "document-uri": `${ORIGIN}/probe`,
      "effective-directive": "integration-probe",
      "blocked-uri": "https://example.com/probe",
      note: padding,
    },
  });
}

async function postReport(body: string) {
  return SELF.fetch(`${ORIGIN}/csp-report`, {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body,
  });
}

describe("/csp-report bounds the body in bytes, before buffering it", () => {
  it("accepts an ordinary report", async () => {
    const resp = await postReport(report("a real violation would say more than this"));
    expect(resp.status).toBe(204);
  });

  it("refuses a body over the cap", async () => {
    const body = report("x".repeat(CAP));
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(413);
  });

  it("counts BYTES, not UTF-16 code units: a multi-byte body over the cap is refused", async () => {
    // Each of these is one code unit and three bytes: 24,000 bytes on the wire, over
    // the cap, while String#length reads 8,000.
    const padding = "あ".repeat(8_000);
    const body = report(padding);
    const bytes = new TextEncoder().encode(body).byteLength;
    expect(body.length).toBeLessThan(CAP);
    expect(bytes).toBeGreaterThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(413);
  });

  it("still accepts a multi-byte body that is genuinely under the cap", async () => {
    // A cap that rejected all multi-byte input would pass the test above for the
    // wrong reason.
    const body = report("あ".repeat(200));
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(CAP);
    const resp = await postReport(body);
    expect(resp.status).toBe(204);
  });
});

describe("/csp-report is rate limited before it reads or stores anything", () => {
  it("a limited caller gets 429 before the content type is checked, and nothing reaches R2", async () => {
    const ip = "203.0.113.77";
    let verdict = await checkRate(env.APP_KV, ip, new Date(), CSP_REPORT_LIMIT);
    for (let i = 0; i < CSP_REPORT_LIMIT.perHour + 1 && verdict.allowed; i++) {
      verdict = await checkRate(env.APP_KV, ip, new Date(), CSP_REPORT_LIMIT);
    }
    expect(verdict.allowed, "the limiter never refused, so this test proves nothing").toBe(false);
    const stored = async () => (await env.MEDIA.list({ prefix: REPORT_PREFIX })).objects.length;
    const before = await stored();

    // A wrong content type is a 415 for an unlimited caller. The limited caller is
    // refused first.
    const wrongType = await SELF.fetch(`${ORIGIN}/csp-report`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "CF-Connecting-IP": ip },
      body: "not a report",
    });
    expect(wrongType.status).toBe(429);

    const valid = await SELF.fetch(`${ORIGIN}/csp-report`, {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": ip },
      body: report("a limited caller"),
    });
    expect(valid.status).toBe(429);
    expect(await valid.text()).toMatch(/^too many reports:/);
    expect(await stored()).toBe(before);
  });
});

describe("a stored report is reaped by the backup cron once it ages past the window", () => {
  // The sink and the prune must agree on where reports live, or reports accumulate
  // under a prefix nothing reaps. The sink stores a real report, a copy is aged by
  // rewriting only the date segment of its key, and the real backup cron runs.
  it("the aged copy is deleted and the fresh report is kept", async () => {
    const posted = await SELF.fetch(`${ORIGIN}/csp-report`, {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": "203.0.113.90" },
      body: report("stored by the sink"),
    });
    expect(posted.status).toBeLessThan(300);

    const today = new Date().toISOString().slice(0, 10);
    const stored = (await env.MEDIA.list({ prefix: REPORT_PREFIX })).objects.map((o) => o.key).filter((k) => k.includes(today));
    expect(stored.length, "the sink stored nothing under the report prefix, so this proves nothing").toBeGreaterThan(0);
    const fresh = stored[0];

    // Same key, dated 40 days ago: past the 30-day retention the prune applies.
    const agedDay = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const aged = fresh.replace(today, agedDay);
    expect(aged).not.toBe(fresh);
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
