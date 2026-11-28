import { env, SELF } from "cloudflare:test";
import { CSP_REPORT_RULES } from "../src/routes";
import { rateLimiter } from "../src/http";
import { limit } from "@dustinedwards/site-runtime/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// /csp-report against the real runtime: site-runtime's receiver behind Capsid's limiter, with CORS for the Portal.
// Every POST is answered 204, nothing is stored, and the logged line carries no query string.

const ORIGIN = "https://capsid.test";

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

const stored = async () => (await env.MEDIA.list()).objects.length;

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
    const resp = await postReport(
      report("a real violation would say more than this", `${ORIGIN}/probe?token=sample-secret`),
    );
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

describe("/csp-report is rate limited before it reads anything", () => {
  it("a limited caller gets 204, and its report is neither logged nor stored", async () => {
    const ip = "203.0.113.77";
    // The sink's own key for this address (site-runtime's ipKey), spent to its hourly limit.
    const spend = () =>
      limit(rateLimiter(env), `csp-report:${ip}`, CSP_REPORT_RULES, { onUnavailable: "refuse" });
    let verdict = await spend();
    for (let i = 0; i < CSP_REPORT_RULES[0].limit + 1 && verdict.status === "ok"; i++)
      verdict = await spend();
    expect(verdict.status, "the limiter never refused, so this test proves nothing").toBe(
      "limited",
    );
    const before = await stored();

    const valid = await postReport(report("a limited caller"), ip);
    expect(valid.status).toBe(204);
    expect(violations()).toHaveLength(0);
    expect(await stored()).toBe(before);
  });
});

describe("/csp-report answers the Portal's preflight", () => {
  it("the Portal's preflight is allowed, and no other origin's is", async () => {
    const preflight = (origin: string) =>
      SELF.fetch(`${ORIGIN}/csp-report`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
    const portal = await preflight("https://portal.dustinedwards.info");
    expect(portal.status).toBe(204);
    expect(portal.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://portal.dustinedwards.info",
    );
    const other = await preflight("https://example.com");
    expect(other.status).toBe(204);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
