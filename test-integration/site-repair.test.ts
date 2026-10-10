import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { readSiteConfig } from "../src/ops-sites";
import type { OpsSiteConfig } from "../src/ops-types";
import { previewControl, performControl } from "../src/controls";
import { watchSites } from "../src/site-watch";
import { handlePortalConvergence } from "../src/portal-convergence";
import { portalSessionCookie } from "../src/portal-auth";
import type { PortalConvergence } from "../src/ops-types";

// The site repairs against a real D1 and KV with every migration applied (job_09e5f6cbf782,
// migrations/0035): the watcher's repair step, its rate limit and its red and green mail,
// and the control refusing what the Worker must never call. The site's operator API and
// health route are answered by a fake fetch; no request leaves the test.

const EMAIL = "admin@example.com";
const TOKEN = "integration-operator-token-0000000000000";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const HEALTH = "https://dustinedwards.info/api/health";
const OPERATOR = "https://dustinedwards.info/api/operator";

type Mail = { to: string; from: string; subject: string; text?: string };

function siteEnv(over: Record<string, unknown> = {}): { env: Env; mails: Mail[] } {
  const mails: Mail[] = [];
  const e = {
    ...(env as unknown as Env),
    DUSTINEDWARDS_OPERATOR_TOKEN: TOKEN,
    COOKIE_ENCRYPTION_KEY: "integration-site-repair-key",
    ADMIN_EMAIL: EMAIL,
    EMAIL: { send: async (m: Mail) => void mails.push(m) },
    ALERT_EMAIL: "seat@example.com",
    ALERT_FROM: "capsid@example.com",
    ...over,
  } as unknown as Env;
  return { env: e, mails };
}

// A site whose pages drift until sync_pages runs, and whose other answers are fixed.
function fakeSite(opts: { drift?: string[]; repairs?: boolean } = {}) {
  let drift = opts.drift ?? ["pages-drift"];
  const calls: string[] = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    if (url === HEALTH) {
      calls.push("health");
      return Response.json({ ok: drift.length === 0, checks: [{ name: "pages-drift", ok: !drift.includes("pages-drift") }, { name: "media-backup-drift", ok: !drift.includes("media-backup-drift") }] }, { status: drift.length ? 503 : 200 });
    }
    if (url === OPERATOR) {
      const tool = JSON.parse(String(init.body)).tool as string;
      calls.push(tool);
      if (tool === "sync_pages" && opts.repairs !== false) drift = drift.filter((d) => d !== "pages-drift");
      if (tool === "refresh_citations") return Response.json({ ok: true, data: { refreshed: 3 } });
      return Response.json({ ok: true, data: { expected: 14, present: opts.repairs === false ? 12 : 14, converged: opts.repairs !== false } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, impl };
}

async function config(): Promise<OpsSiteConfig[]> {
  return (await readSiteConfig(env.DB)).filter((c) => c.namespace === "dustinedwards");
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM task_runs").run();
  for (const prefix of ["site-repair-limit:", "site-weekly:", "site-alert:"]) {
    for (const key of (await env.APP_KV.list({ prefix })).keys) await env.APP_KV.delete(key.name);
  }
});

describe("the watcher's site repairs", () => {
  it("repairs a mapped drift, re-checks, records the call, and raises nothing when it settles", async () => {
    const { env: e, mails } = siteEnv();
    // The weekly tool has run, so this pass is the repair alone.
    await env.APP_KV.put("site-weekly:dustinedwards:refresh_citations", NOW.toISOString());
    const site = fakeSite();
    const report = await watchSites(e, await config(), "agent:watcher", site.impl, NOW);
    expect(site.calls).toEqual(["health", "sync_pages", "health"]);
    expect(report.findings).toEqual([]);
    expect(report.complete).toBe(true);
    expect(mails).toEqual([]);
    const audit = await env.DB.prepare("SELECT actor, action, params FROM audit_log").all<{ actor: string; action: string; params: string }>();
    expect(audit.results.map((r) => [r.actor, r.action, JSON.parse(r.params).tool, JSON.parse(r.params).via])).toEqual([["agent:watcher", "site-repair", "sync_pages", "watcher"]]);
    const runs = await env.DB.prepare("SELECT task, outcome FROM task_runs").all<{ task: string; outcome: string }>();
    expect(runs.results).toEqual([{ task: "site-repair", outcome: "ok" }]);
  });

  it("repairs nothing when a failing check maps to no repair, opens the incident, and mails once on the change", async () => {
    const { env: e, mails } = siteEnv();
    await env.APP_KV.put("site-weekly:dustinedwards:refresh_citations", NOW.toISOString());
    const site = fakeSite({ drift: ["pages-drift", "media-backup-drift"] });
    const first = await watchSites(e, await config(), "agent:watcher", site.impl, NOW);
    expect(site.calls).toEqual(["health"]);
    expect(first.findings.map((f) => f.fingerprint)).toEqual(["site-health-dustinedwards"]);
    expect(first.findings[0].evidence.join(" ")).toMatch(/media-backup-drift maps to no repair/);
    expect(mails.map((m) => m.subject)).toEqual(["dustinedwards.info is unhealthy and self-repair did not settle it"]);

    // Still red next pass: no second mail. Green after: one recovery mail.
    await watchSites(e, await config(), "agent:watcher", site.impl, later(30));
    expect(mails).toHaveLength(1);
    const green = fakeSite({ drift: [] });
    expect((await watchSites(e, await config(), "agent:watcher", green.impl, later(60))).findings).toEqual([]);
    expect(mails.map((m) => m.subject)).toEqual(["dustinedwards.info is unhealthy and self-repair did not settle it", "dustinedwards.info recovered"]);
  });

  it("stops repairing a stuck check after its daily limit, keeps the incident open, and says why", async () => {
    const { env: e } = siteEnv();
    await env.APP_KV.put("site-weekly:dustinedwards:refresh_citations", NOW.toISOString());
    const stuck = fakeSite({ repairs: false });
    let last = null as Awaited<ReturnType<typeof watchSites>> | null;
    for (let pass = 0; pass < 6; pass++) last = await watchSites(e, await config(), "agent:watcher", stuck.impl, later(pass * 31));
    expect(stuck.calls.filter((c) => c === "sync_pages")).toHaveLength(4);
    expect(last?.findings[0].evidence.join(" ")).toMatch(/the watcher has run it 4 times in the last day/);
  });

  it("runs the weekly tool once a week, and says it was not mailed when no binding is set", async () => {
    const { env: e } = siteEnv({ EMAIL: undefined });
    const site = fakeSite({ drift: [] });
    await watchSites(e, await config(), "agent:watcher", site.impl, NOW);
    await watchSites(e, await config(), "agent:watcher", site.impl, later(60));
    expect(site.calls.filter((c) => c === "refresh_citations")).toHaveLength(1);
    const red = fakeSite({ drift: ["media-backup-drift"] });
    const report = await watchSites(e, await config(), "agent:watcher", red.impl, later(90));
    expect(report.lines.join(" ")).toMatch(/was not mailed: no send_email binding/);
  });

  it("with the token unset, calls nothing and says so in the incident", async () => {
    const { env: e } = siteEnv({ DUSTINEDWARDS_OPERATOR_TOKEN: undefined });
    await env.APP_KV.put("site-weekly:dustinedwards:refresh_citations", NOW.toISOString());
    const site = fakeSite();
    const report = await watchSites(e, await config(), "agent:watcher", site.impl, NOW);
    expect(site.calls).toEqual(["health"]);
    expect(report.findings[0].evidence.join(" ")).toMatch(/DUSTINEDWARDS_OPERATOR_TOKEN is not set/);
  });
});

describe("GET /portal/api/convergence", () => {
  it("reads the operator API and the health route live, maps each check to its repair, and lists the last repair", async () => {
    const { env: e } = siteEnv();
    await env.APP_KV.put("site-weekly:dustinedwards:refresh_citations", NOW.toISOString());
    const site = fakeSite();
    await watchSites(e, await config(), "agent:watcher", site.impl, NOW);
    const status = async (url: string, init?: RequestInit) =>
      url === OPERATOR && JSON.parse(String(init?.body)).tool === "sync_status"
        ? Response.json({ ok: true, data: { headSha: "abc1234", d1Posts: 42, divergences: { known: true, list: [] } } })
        : site.impl(url, init);
    const session = (await portalSessionCookie({ email: EMAIL }, "integration-site-repair-key", new Date())).split(";")[0];
    const request = new Request("https://capsid.test/portal/api/convergence", { headers: { Cookie: session, "Sec-Fetch-Site": "same-origin" }, redirect: "manual" });
    const response = await handlePortalConvergence(request, e, new Date(), status as typeof fetch);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PortalConvergence;
    expect(body.sites.map((s) => s.namespace)).toEqual(["dustinedwards"]);
    const s = body.sites[0];
    expect(s.operator?.secret_set).toBe(true);
    expect(s.status?.fields).toEqual([{ key: "headSha", value: "abc1234" }, { key: "d1Posts", value: "42" }, { key: "divergences", value: "none" }]);
    expect(s.health?.checks.map((c) => [c.name, c.ok, c.repair])).toEqual([["pages-drift", true, "sync_pages"], ["media-backup-drift", true, null]]);
    expect(s.recent.map((r) => [r.tool, r.actor, r.converged])).toEqual([["sync_pages", "agent:watcher", true]]);
    expect(Number.isNaN(Date.parse(s.recent[0].at))).toBe(false);
    expect(s.secrets?.state).toBe("none");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

describe("the site_repair control", () => {
  it("PLANT: refuses backup_media and a tool outside the site's list at preview, and a token for either at perform, writing nothing", async () => {
    const { env: e } = siteEnv();
    for (const tool of ["backup_media", "save_post", "sync_unlisted"]) {
      const previewed = await previewControl(e, EMAIL, "site_repair", { namespace: "dustinedwards", tool }, NOW, "chat");
      expect(previewed.ok, `${tool} was previewed`).toBe(false);
    }
    // A token for a tool the site allows, performed after the site's list dropped it.
    const previewed = await previewControl(e, EMAIL, "site_repair", { namespace: "dustinedwards", tool: "sync_pages" }, NOW, "chat");
    expect(previewed.ok).toBe(true);
    const row = await env.DB.prepare("SELECT operator FROM ops_sites WHERE namespace = 'dustinedwards'").first<{ operator: string }>();
    const narrowed = JSON.parse(row!.operator);
    delete narrowed.repairs["pages-drift"];
    await env.DB.prepare("UPDATE ops_sites SET operator = ?1 WHERE namespace = 'dustinedwards'").bind(JSON.stringify(narrowed)).run();
    try {
      const performed = await performControl(e, EMAIL, previewed.ok ? previewed.preview.token : "", null, NOW, "chat");
      expect(performed.ok).toBe(false);
      expect(performed.ok ? "" : performed.refusal).toMatch(/sync_pages is not in this site's allowlist/);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site-repair'").first<{ n: number }>())?.n).toBe(0);
    } finally {
      await env.DB.prepare("UPDATE ops_sites SET operator = ?1 WHERE namespace = 'dustinedwards'").bind(row!.operator).run();
    }
  });
});
