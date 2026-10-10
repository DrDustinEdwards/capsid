// Dev and preview only: serves dev/sample-feed.json at /portal/api/ops so `npm run
// dev`, and the browser tests under `vite preview`, run with fake data and no Worker.
// Never part of the build (apply: "serve").
//
// The fixture's timestamps are fixed; each response shifts every ISO timestamp and
// ring_slot so live.generated is "now", which keeps the relative times readable.
//
// It also mocks the Portal's controls (preview and perform), GET
// /portal/api/namespaces, GET /portal/api/activity, GET /portal/api/claims, GET
// /portal/api/stale, GET /portal/api/maintenance and POST
// /portal/api/sign-out, with
// the Worker's refusals:
// text/plain 400 for a bad request, 403 for a missing or wrong X-Capsid-CSRF, 410 for
// an expired token, 413 for a body over 8 KB. Changes live in memory until the dev
// server restarts.
//
// WF_MOCK=signed-out answers 401, WF_MOCK=no-snapshot drops the watcher pass,
// WF_MOCK=no-token marks Cloudflare as not configured, WF_MOCK=expired answers every
// perform with 410, WF_MOCK=warn performs with a warning, WF_MOCK=no-sites starts with
// no site configured (live.sites and the snapshot's sites empty), so the Portal hides
// its Sites view and the Overview's site items.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { DASHBOARD_CSP } from "../../src/dashboard-csp.ts";
import type {
  ClaimsGroup,
  OpsFeed,
  OpsJob,
  OpsPackageConfig,
  OpsSiteConfig,
  PortalAction,
  PortalActivity,
  PortalPackageHistory,
  PortalStale,
  PortalMaintenance,
  PortalConvergence,
  ConvergenceSite,
  OpsStaleJob,
  PortalActivityRow,
  PortalClaimsAggregate,
  PortalClaimsJob,
  PortalNamespace,
  PortalNamespaces,
  PortalPerformed,
  PortalPreview,
} from "../src/types.ts";

const FIXTURE = fileURLToPath(new URL("./sample-feed.json", import.meta.url));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SLOT_MS = 30 * 60_000;
const REFRESH_GAP_MS = 30_000;
const TOKEN_MS = 5 * 60_000;
const MAX_BODY = 8 * 1024;
const ACTOR = "admin@example.com";
const ACTIONS: PortalAction[] = ["pause", "unpause", "mode", "seat_start", "overnight", "resume_job", "release_job", "fail_job", "close_shipped", "revoke_agent", "site_add", "site_edit", "site_remove", "reset_breaker", "package_add", "package_edit", "package_remove", "canon_approve", "canon_reject", "site_repair"];
// The automation switches: a reason in both directions, and an optional undo: "true"
// that the Worker records as portal-undo-<action> (src/portal-actions.ts).
const SWITCHES: PortalAction[] = ["pause", "unpause", "mode", "seat_start", "overnight"];

// The click row's action name, as the Worker names it, in the mock's "portal." form.
function clickName(action: PortalAction, params: Record<string, string>): string {
  return `portal.${params.undo === "true" ? "undo-" : ""}${action}`;
}

// The Worker's checks on the switches' shared params, with its refusal text.
function checkSwitch(action: PortalAction, params: Record<string, string>): void {
  if (params.undo !== undefined && !SWITCHES.includes(action)) throw new Refusal(400, `${action} takes no undo; 'undo' is not one of them.`);
  if (!SWITCHES.includes(action)) return;
  if (params.undo !== undefined && params.undo !== "true") throw new Refusal(400, `${action}'s undo is "true" or absent; got '${params.undo}'.`);
  if (!(params.reason ?? "").trim()) throw new Refusal(400, `${action} needs a reason. It is recorded in the audit row with the change.`);
}
// The namespaces whose queue breaker is open in the sample, until a reset closes it.
const BREAKER_OPEN = ["sample-b"];
// Registered in the mock but with no site row, so an add has somewhere to go. The site
// map in the fixture reports it as unmapped.
const EXTRA_REGISTERED = ["sample-i"];

// WF_MOCK_NOW (an ISO time) pins the mock's clock, so the screenshots
// (playwright.shots.config.ts) show the same times on every run. Unset, it is the real
// clock. A value that is not a time stops the server rather than being ignored.
const PINNED_NOW = process.env.WF_MOCK_NOW ? Date.parse(process.env.WF_MOCK_NOW) : null;
if (PINNED_NOW !== null && Number.isNaN(PINNED_NOW)) throw new Error(`WF_MOCK_NOW is not an ISO time: '${process.env.WF_MOCK_NOW}'`);
function mockNow(): number {
  return PINNED_NOW ?? Date.now();
}

function shift(value: unknown, delta: number): unknown {
  if (typeof value === "string" && ISO.test(value)) return new Date(Date.parse(value) + delta).toISOString();
  if (Array.isArray(value)) return value.map((v) => shift(v, delta));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "ring_slot" && typeof v === "number" ? v + Math.round(delta / SLOT_MS) : shift(v, delta);
    }
    return out;
  }
  return value;
}

// What the controls changed since the dev server started.
interface MockState {
  paused: Map<string, string | null>;
  // Namespaces whose breaker was reset since the mock started.
  breakerReset: Set<string>;
  mode: string | null;
  seat: boolean | null;
  overnight: "off" | "api" | "subscription" | null;
  // The reason typed when the overnight switch was last set, recorded with the decision.
  overnightReason: string;
  jobs: Map<string, Partial<OpsJob>>;
  revoked: Map<string, string>;
  // The site configuration as it stands, every row, by namespace.
  sites: OpsSiteConfig[];
  // The package configuration as it stands.
  packages: OpsPackageConfig[];
  activity: PortalActivityRow[];
  // Canon proposals approved or rejected since the mock started.
  canonDecided: Set<number>;
  // Repairs run since the mock started, newest first (GET /portal/api/convergence).
  repairs: Array<{ namespace: string; tool: string; at: string }>;
  tokens: Map<string, { action: PortalAction; params: Record<string, string>; expires: number }>;
}

function fixture(): OpsFeed {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  const delta = mockNow() - Date.parse(raw.live.generated);
  return shift(raw, delta) as OpsFeed;
}

// D1's datetime('now') shape, which is what the Worker sends for updated_at.
function sqlNow(t = mockNow()): string {
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

// The fixture's rows, with updated_at shifted as fixture() shifts the ISO timestamps
// (it is D1's shape, not ISO, so shift() leaves it alone). WF_MOCK=no-sites starts empty.
function seedSites(): OpsSiteConfig[] {
  if (process.env.WF_MOCK === "no-sites") return [];
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  const delta = mockNow() - Date.parse(raw.live.generated);
  return raw.live.sites.map((s) => ({ ...s, updated_at: sqlNow(Date.parse(`${s.updated_at.replace(" ", "T")}Z`) + delta) }));
}

// The fixture's packages. WF_MOCK=no-packages starts with none, so the Packages view
// is not offered.
function seedPackages(): OpsPackageConfig[] {
  if (process.env.WF_MOCK === "no-packages") return [];
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  return raw.live.packages.map((p) => ({ ...p }));
}

// A made-up daily history for a configured package: the former name from 2025-06-01
// to 2026-06-30, then the current name, a few downloads a day with a weekly rhythm.
function mockHistory(p: OpsPackageConfig): PortalPackageHistory {
  const now = mockNow();
  const days: PortalPackageHistory["days"] = [];
  const DAY = 86_400_000;
  for (let t = Date.parse("2025-06-01T00:00:00Z"); t < now - DAY; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const name = p.formerly && day < "2026-07-01" ? p.formerly : p.name;
    const n = Math.round(3 + 2 * Math.sin(t / (7 * DAY)) + ((t / DAY) % 11 === 0 ? 20 : 0));
    if (n > 0) days.push({ day, downloads: n, name });
  }
  return {
    name: p.name,
    formerly: p.formerly,
    generated: new Date(now).toISOString(),
    fetched_at: new Date(now).toISOString(),
    days,
    first_day: days[0]?.day ?? null,
    last_day: days[days.length - 1]?.day ?? null,
    notes: [],
    weeks: [
      { week: "2026-W39", stars: 4, open_issues: 1, open_prs: 2, latest_release: "v0.3.0" },
      { week: "2026-W38", stars: 3, open_issues: 1, open_prs: 1, latest_release: "v0.2.0" },
    ],
  };
}

// Registered namespaces: the roster, every row the fixture seeds, and EXTRA_REGISTERED.
// Removing a row does not unregister its namespace.
function registered(): Set<string> {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  return new Set([...raw.live.namespaces.map((n) => n.name), ...raw.live.sites.map((s) => s.namespace), ...EXTRA_REGISTERED]);
}

// The Worker's validation (src/ops-sites.ts, validateSite), with its refusal text, in
// the parts a person is likely to hit. The mock does not import it: dev code stays off
// the Worker's runtime modules, as the app does.
type SiteFields = Pick<OpsSiteConfig, "namespace" | "name" | "origin" | "health_path" | "platform" | "script">;
function validateSite(p: Record<string, string>): SiteFields {
  const namespace = p.namespace ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) throw new Refusal(400, `'${namespace}' is not a namespace name: lowercase letters, digits and hyphens.`);
  const name = p.name ?? namespace;
  if (name.length > 80) throw new Refusal(400, "the name must be at most 80 characters with no control characters.");
  if (!p.origin) {
    if (p.health_path || p.platform || p.script) throw new Refusal(400, "a namespace that serves no site takes no health path, platform or script. Give an origin to make it a site.");
    return { namespace, name, origin: null, health_path: null, platform: null, script: null };
  }
  const m = /^https:\/\/([^/?#@:]+)\/?$/.exec(p.origin);
  if (!m) {
    if (!/^https:\/\//i.test(p.origin)) throw new Refusal(400, `the origin must start with https://; got '${p.origin}'.`);
    throw new Refusal(400, `the origin is https:// and a hostname only, with no user, port, path, query or fragment; put a health route in the health path. Got '${p.origin}'.`);
  }
  const host = m[1] ?? "";
  if (host !== host.toLowerCase()) throw new Refusal(400, `the hostname '${host}' must be lowercase.`);
  if (!host.includes(".")) throw new Refusal(400, `'${host}' is a single-label name; a site needs a public hostname such as example.com.`);
  if (p.platform !== "cloudflare" && p.platform !== "vercel") throw new Refusal(400, `the platform must be one of cloudflare, vercel; got '${p.platform ?? ""}'.`);
  if (p.health_path && !/^\/[A-Za-z0-9._~\/-]{0,199}$/.test(p.health_path)) {
    throw new Refusal(400, `the health path '${p.health_path}' must start with / and use only letters, digits and - . _ ~ /, at most 200 characters, with no query or fragment.`);
  }
  if (p.script) {
    if (p.platform !== "cloudflare") throw new Refusal(400, "only a Cloudflare site names a Worker script.");
    if (!/^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/.test(p.script)) throw new Refusal(400, `'${p.script}' is not a Worker script name: lowercase letters, digits, - and _.`);
  }
  return { namespace, name, origin: `https://${host}`, health_path: p.health_path ?? null, platform: p.platform, script: p.script ?? null };
}

function describeSite(s: SiteFields): string {
  if (s.origin === null) return `"${s.name}", serves no site (not probed)`;
  const probe = s.health_path ? `${s.origin}${s.health_path}` : `${s.origin}/ (no health route, so the root)`;
  return `"${s.name}", probed at ${probe}, on ${s.platform}${s.script ? `, Worker script ${s.script}` : ""}`;
}

function revisionOf(raw: string | undefined): number | null {
  return raw && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
}

const SITE_FIELDS = ["name", "origin", "health_path", "platform", "script"] as const;

function feed(nextRefresh: number, st: MockState): OpsFeed {
  const out = fixture();
  const mode = process.env.WF_MOCK;
  if (mode === "no-snapshot") out.snapshot = null;
  if (mode === "no-sites" && out.snapshot) out.snapshot.sites = [];
  if (mode === "no-token") {
    out.cloudflare_configured = false;
    for (const s of out.snapshot?.sites ?? []) {
      if (s.platform === "cloudflare") s.cloudflare = { state: "no-token", reason: "CF_OPS_TOKEN is not set" };
    }
  }
  for (const n of out.live.namespaces) if (st.paused.has(n.name)) n.paused = st.paused.get(n.name) ?? null;
  if (st.mode != null) out.live.loop.mode = st.mode;
  if (st.seat != null) out.live.seat_start.enabled = st.seat;
  if (st.overnight != null) {
    out.live.overnight = {
      mode: st.overnight,
      // As the Worker records it when the subscription is chosen (src/overnight.ts).
      decision:
        st.overnight === "subscription"
          ? {
              decided_by: "Sample Person",
              decided_on: "2026-10-04",
              ruling: "capsid/decisions.md, 2026-10-04: overnight runs may use the subscription, by the owner's choice",
              reasoning: "The use is personal, on the owner's own repositories, and not shared.",
              set_by: `access:${ACTOR}`,
              set_at: new Date(mockNow()).toISOString(),
              reason: st.overnightReason,
            }
          : null,
    };
  }
  out.live.jobs = out.live.jobs.map((j) => ({ ...j, ...st.jobs.get(j.id) }));
  for (const a of out.live.agents) if (st.revoked.has(a.name)) a.revoked_at = st.revoked.get(a.name) ?? null;
  out.live.sites = st.sites.map((s) => ({ ...s }));
  out.live.packages = st.packages.map((p) => ({ ...p }));
  out.live.canon_proposals = out.live.canon_proposals.filter((c) => !st.canonDecided.has(c.id));
  out.refresh_allowed_at = nextRefresh > mockNow() ? new Date(nextRefresh).toISOString() : null;
  return out;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function refuse(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Refusal(413, `The request body is over ${MAX_BODY} bytes.`));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function need(params: Record<string, string>, key: string, what: string): string {
  const v = (params[key] ?? "").trim();
  if (!v) throw new Refusal(400, `${what} is required.`);
  return v;
}

// What an action would do against the feed as it stands. Throws a Refusal for a
// request the Worker would refuse.
function plan(f: OpsFeed, action: PortalAction, params: Record<string, string>): { summary: string; done: string; changes: string[]; apply: (st: MockState) => void } {
  checkSwitch(action, params);
  const now = new Date(mockNow()).toISOString();
  const job = () => {
    const id = need(params, "id", "The job id");
    const j = f.live.jobs.find((x) => x.id === id);
    if (!j) throw new Refusal(400, `No job ${id}.`);
    return j;
  };
  switch (action) {
    case "pause": {
      const ns = need(params, "namespace", "The namespace");
      const reason = params.reason?.trim() ?? "";
      const n = f.live.namespaces.find((x) => x.name === ns);
      if (!n) throw new Refusal(400, `${ns} is not a roster namespace.`);
      if (n.paused != null) throw new Refusal(400, `${ns} is already paused: ${n.paused}`);
      return { summary: `Pause the improve loop for ${ns}.`, done: `Paused the improve loop for ${ns}.`, changes: [`improve:paused:${ns}: not set -> "${reason}"`, "The next scheduled run for this namespace is skipped."], apply: (st) => void st.paused.set(ns, reason) };
    }
    case "reset_breaker": {
      const ns = need(params, "namespace", "The namespace");
      if (!f.live.namespaces.some((x) => x.name === ns)) throw new Refusal(400, `${ns} is not a roster namespace.`);
      return {
        summary: `Reset the queue's circuit breaker for ${ns}.`,
        done: `Reset the circuit breaker for ${ns}.`,
        changes: [`jobs:breaker:reset:${ns}: -> now. Holder fails before now stop counting.`],
        apply: (st) => void st.breakerReset.add(ns),
      };
    }
    case "unpause": {
      const ns = need(params, "namespace", "The namespace");
      const n = f.live.namespaces.find((x) => x.name === ns);
      if (!n) throw new Refusal(400, `${ns} is not a roster namespace.`);
      if (n.paused == null) throw new Refusal(400, `${ns} is not paused.`);
      return { summary: `Unpause the improve loop for ${ns}.`, done: `Unpaused the improve loop for ${ns}.`, changes: [`improve:paused:${ns}: "${n.paused}" -> not set`], apply: (st) => void st.paused.set(ns, null) };
    }
    case "mode": {
      const value = need(params, "value", "The mode");
      if (!["api", "subscription", "off"].includes(value)) throw new Refusal(400, `Mode must be api, subscription or off, not ${value}.`);
      if (value === f.live.loop.mode) throw new Refusal(400, `The improve loop is already ${value}.`);
      return { summary: `Set the improve loop to ${value}.`, done: `The improve loop is now ${value}.`, changes: [`improve:mode: ${f.live.loop.mode} -> ${value}`], apply: (st) => void (st.mode = value) };
    }
    case "overnight": {
      const value = need(params, "value", "The value");
      if (!["api", "subscription", "off"].includes(value)) throw new Refusal(400, `overnight must be api, subscription or off, not ${value}.`);
      if (value === f.live.overnight.mode) throw new Refusal(400, `The overnight run is already ${value}.`);
      return {
        summary: `Set the overnight run to ${value}.`,
        done: `The overnight run is now ${value}.`,
        changes: [`overnight:mode: ${f.live.overnight.mode} -> ${value}`, ...(value === "subscription" ? ["Recorded with the switch: the owner's decision of 2026-10-04 and its reasoning."] : [])],
        apply: (st) => {
          st.overnight = value as "api" | "subscription" | "off";
          st.overnightReason = params.reason?.trim() ?? "";
        },
      };
    }
    case "seat_start": {
      const value = need(params, "value", "The value");
      if (value !== "on" && value !== "off") throw new Refusal(400, `seat_start must be on or off, not ${value}.`);
      const on = value === "on";
      if (on === f.live.seat_start.enabled) throw new Refusal(400, `Seat start is already ${value}.`);
      return { summary: `Turn seat start ${value}.`, done: `Seat start is ${value}.`, changes: [`seat:start:enabled: ${f.live.seat_start.enabled ? "on" : "off"} -> ${value}`], apply: (st) => void (st.seat = on) };
    }
    case "resume_job": {
      const j = job();
      need(params, "reason", "A reason");
      if (j.status !== "blocked") throw new Refusal(400, `Job ${j.id} is ${j.status}, not blocked. Only a blocked job resumes.`);
      return {
        summary: `Resume ${j.id} (${j.title}).`,
        done: `Resumed ${j.id}; it is queued.`,
        changes: [
          `jobs.${j.id}.status: blocked -> queued`,
          `jobs.${j.id}.resumed_count: ${j.resumed_count} -> ${j.resumed_count + 1}`,
          ...(params.note ? [`The resume note carries your note of ${params.note.length} characters in full.`] : []),
        ],
        apply: (st) => void st.jobs.set(j.id, { status: "queued", waits_on: null, command: null, claimed_by: null, lease_expires: null, resumed_count: j.resumed_count + 1, updated_at: now }),
      };
    }
    case "close_shipped": {
      const j = job();
      need(params, "reason", "A reason");
      if (j.status !== "blocked") throw new Refusal(400, `Job ${j.id} is ${j.status}, not blocked. Close as shipped ends a blocked job whose work landed.`);
      return {
        summary: `Close ${j.id} (${j.title}) as shipped.`,
        done: `Closed ${j.id} as shipped; the outcome is credited to ${j.claimed_by ?? "its holder"}.`,
        changes: [`jobs.${j.id}.status: blocked -> done`, `The outcome row credits ${j.claimed_by ?? "nobody"}, who did the work. No claim is recorded for you.`],
        apply: (st) => void st.jobs.set(j.id, { status: "done", waits_on: null, command: null, lease_expires: null, updated_at: now }),
      };
    }
    case "release_job": {
      const j = job();
      need(params, "reason", "A reason");
      if (j.status !== "claimed") throw new Refusal(400, `Job ${j.id} is ${j.status}, not claimed. Only a claimed job is released.`);
      return {
        summary: `Release ${j.id} from ${j.claimed_by ?? "its holder"}.`,
        done: `Released ${j.id}; it is queued.`,
        changes: [`jobs.${j.id}.status: claimed -> queued`, `jobs.${j.id}.claimed_by: ${j.claimed_by ?? "none"} -> none`],
        apply: (st) => void st.jobs.set(j.id, { status: "queued", claimed_by: null, lease_expires: null, updated_at: now }),
      };
    }
    case "fail_job": {
      const j = job();
      need(params, "reason", "A reason");
      if (!["queued", "claimed", "blocked"].includes(j.status)) throw new Refusal(400, `Job ${j.id} is ${j.status}; only an open job can be marked failed.`);
      return { summary: `Mark ${j.id} failed.`, done: `Marked ${j.id} failed.`, changes: [`jobs.${j.id}.status: ${j.status} -> failed`], apply: (st) => void st.jobs.set(j.id, { status: "failed", claimed_by: null, lease_expires: null, updated_at: now }) };
    }
    case "revoke_agent": {
      const name = need(params, "name", "The agent name");
      const a = f.live.agents.find((x) => x.name === name);
      if (!a) throw new Refusal(400, `No agent ${name}.`);
      if (a.revoked_at) throw new Refusal(400, `${name} is already revoked.`);
      const held = f.live.jobs.filter((j) => j.status === "claimed" && (j.claimed_by === name || j.claimed_by === `agent:${name}`));
      return {
        summary: `Revoke the agent ${name}.`,
        done: `Revoked ${name}.`,
        changes: [`agents.${name}.revoked_at: none -> now`, "Its token stops working on the next request.", ...held.map((j) => `Job ${j.id} it holds stays claimed until its lease runs out.`)],
        apply: (st) => void st.revoked.set(name, now),
      };
    }
    case "site_add": {
      const site = validateSite(params);
      if (!registered().has(site.namespace)) throw new Refusal(400, `'${site.namespace}' is not a registered namespace. Register it first; a site row for an unregistered namespace is drift the watcher reports.`);
      const existing = f.live.sites.find((s) => s.namespace === site.namespace);
      if (existing) throw new Refusal(400, `${site.namespace} already has a row (${describeSite(existing)}). Edit it instead.`);
      return {
        summary: `Add ${site.namespace} to the site configuration.`,
        done: `Added ${site.namespace}: ${describeSite(site)}.`,
        changes: [`ops_sites: add ${site.namespace}, ${describeSite(site)}.`, site.origin ? "The watcher probes it from its next pass, and the Sites view lists it." : `Nothing is probed for ${site.namespace}; the site-map check counts it as decided.`],
        apply: (st) => {
          st.sites.push({ ...site, self_probe: false, revision: 1, updated_at: sqlNow(), operator: null, operator_problem: null });
          st.sites.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));
        },
      };
    }
    case "site_edit": {
      const revision = revisionOf(params.revision);
      if (revision === null) throw new Refusal(400, "site_edit needs the revision of the row it edits.");
      const site = validateSite(params);
      const before = f.live.sites.find((s) => s.namespace === site.namespace);
      if (!before) throw new Refusal(400, `${site.namespace} has no row to edit. Add it instead.`);
      if (before.revision !== revision) throw new Refusal(400, `${site.namespace} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`);
      const shown = (v: string | null) => (v === null ? "(none)" : `"${v}"`);
      const diffs = SITE_FIELDS.filter((k) => before[k] !== site[k]).map((k) => `  ${k}: ${shown(before[k])} -> ${shown(site[k])}`);
      if (!diffs.length) throw new Refusal(400, `the edit changes nothing in ${site.namespace}.`);
      return {
        summary: `Change ${site.namespace} in the site configuration.`,
        done: `Changed ${site.namespace}: ${describeSite(site)}.`,
        changes: [`ops_sites ${site.namespace}, revision ${revision} -> ${revision + 1}:`, ...diffs],
        apply: (st) => {
          const i = st.sites.findIndex((s) => s.namespace === site.namespace);
          const cur = st.sites[i];
          if (!cur) throw new Refusal(400, `${site.namespace} has no row to edit. Add it instead.`);
          st.sites[i] = { ...cur, ...site, self_probe: cur.self_probe && cur.origin === site.origin, revision: cur.revision + 1, updated_at: sqlNow() };
        },
      };
    }
    case "site_remove": {
      const ns = need(params, "namespace", "The namespace");
      const revision = revisionOf(params.revision);
      if (revision === null) throw new Refusal(400, "site_remove needs a namespace and the revision of the row it removes.");
      const before = f.live.sites.find((s) => s.namespace === ns);
      if (!before) throw new Refusal(400, `${ns} has no row to remove.`);
      if (before.revision !== revision) throw new Refusal(400, `${ns} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`);
      return {
        summary: `Remove ${ns} from the site configuration.`,
        done: `Removed ${ns} from the site configuration.`,
        changes: [
          `ops_sites: remove ${ns} (${describeSite(before)}). The row is kept in the audit row.`,
          before.origin ? `The watcher stops probing ${before.origin}, and its uptime ring leaves the next pass.` : "Nothing was probed for it.",
          ...(registered().has(ns) ? [`${ns} is still registered, so the site-map check reports it as unmapped until it has a row again.`] : []),
        ],
        apply: (st) => void (st.sites = st.sites.filter((s) => s.namespace !== ns)),
      };
    }
    case "package_add":
    case "package_edit": {
      const name = need(params, "name", "The npm name");
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) throw new Refusal(400, `the name '${name}' is not an npm package name.`);
      const repo = params.repo?.trim() || null;
      const formerly = params.formerly?.trim() || null;
      const before = f.live.packages.find((p) => p.name === name);
      if (action === "package_add") {
        if (before) throw new Refusal(400, `${name} is already configured. Edit it instead.`);
        return {
          summary: `Add ${name}.`,
          done: `Added ${name}.`,
          changes: [`ops_packages: add npm "${name}"${repo ? `, repository ${repo}` : ""}${formerly ? `, formerly "${formerly}"` : ""}.`],
          apply: (st) => void st.packages.push({ name, registry: "npm", repo, formerly, revision: 1, updated_at: sqlNow(mockNow()) }),
        };
      }
      const revision = revisionOf(params.revision);
      if (!before || revision === null) throw new Refusal(400, `${name} is not configured.`);
      if (before.revision !== revision) throw new Refusal(400, `${name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and edit again.`);
      return {
        summary: `Change ${name}.`,
        done: `Changed ${name}.`,
        changes: [`ops_packages ${name}, revision ${revision} -> ${revision + 1}.`],
        apply: (st) => void (st.packages = st.packages.map((p) => (p.name === name ? { ...p, repo, formerly, revision: p.revision + 1, updated_at: sqlNow(mockNow()) } : p))),
      };
    }
    case "package_remove": {
      const name = need(params, "name", "The npm name");
      const revision = revisionOf(params.revision);
      const before = f.live.packages.find((p) => p.name === name);
      if (!before || revision === null) throw new Refusal(400, `${name} is not configured.`);
      if (before.revision !== revision) throw new Refusal(400, `${name} changed since you opened it (revision ${before.revision}, not ${revision}). Reload and try again.`);
      return {
        summary: `Remove ${name}.`,
        done: `Removed ${name}.`,
        changes: [`ops_packages: remove ${name}. Its weekly rows stay.`],
        apply: (st) => void (st.packages = st.packages.filter((p) => p.name !== name)),
      };
    }
    case "canon_approve":
    case "canon_reject": {
      const id = revisionOf(params.id);
      const proposal = f.live.canon_proposals.find((c) => c.id === id);
      if (id === null || !proposal) throw new Refusal(400, `no pending canon proposal ${params.id ?? ""}.`);
      const target = `${proposal.namespace}/${proposal.path}`;
      if (action === "canon_reject") {
        if (!(params.reason ?? "").trim()) throw new Refusal(400, "canon_reject needs a reason: the proposer reads it, and a rejection with no reason is one nobody can act on.");
        return {
          summary: `Reject canon proposal ${id}.`,
          done: `Rejected proposal ${id} for ${target}.`,
          changes: [`canon proposal ${id} (${target}): pending -> rejected. ${target} is not touched.`],
          apply: (st) => void st.canonDecided.add(id),
        };
      }
      if (proposal.stale) throw new Refusal(400, `${target} changed since proposal ${id} was written. Reject it, and the proposer writes it again.`);
      return {
        summary: `Approve canon proposal ${id}.`,
        done: `Approved proposal ${id}: ${target} is written as ${proposal.proposer} proposed.`,
        changes: [
          `${target} is overwritten as ${proposal.proposer} proposed. The current version is snapshotted first.`,
          `${proposal.added} line(s) added, ${proposal.removed} removed.`,
          ...proposal.directive_lines.map((l) => `instruction: ${l}`),
          "added: The sample service answers on port 8080.",
        ],
        apply: (st) => void st.canonDecided.add(id),
      };
    }
    case "site_repair": {
      const ns = need(params, "namespace", "The namespace");
      const tool = need(params, "tool", "The tool");
      const site = f.live.sites.find((s) => s.namespace === ns);
      if (!site?.origin || !site.operator) throw new Refusal(400, `${ns} has no operator API configured, so Capsid may call nothing on it.`);
      if (tool === "backup_media") throw new Refusal(400, "backup_media is not a repair Capsid may call: it copies the media bucket, and it stays with the site's own watchdog.");
      const allowed = [...new Set([...Object.values(site.operator.repairs), ...site.operator.weekly])];
      if (!allowed.includes(tool)) throw new Refusal(400, `${tool} is not in this site's allowlist (${allowed.join(", ")}).`);
      return {
        summary: `Run ${tool} on ${ns} through its operator API.`,
        done: `${ns}: ${tool} converged (14 of 14 present).`,
        changes: [
          `POST ${site.origin}${site.operator.path} with tool ${tool}, authorized by the Capsid Worker secret ${site.operator.auth_var} (the token is never shown or recorded).`,
          "The site re-derives that store from its source and reports a read-back verdict; the result is shown when it returns, up to a minute.",
        ],
        apply: (st) => void st.repairs.unshift({ namespace: ns, tool, at: now }),
      };
    }
  }
}

// GET /portal/api/stale, from the feed's own jobs so each row opens a drawer: the first
// blocked job as if its pull requests had all merged, and every blocked or claimed job
// unchanged for 3 days by the Worker's rule (src/stale-jobs.ts).
function stale(f: OpsFeed): PortalStale {
  const now = mockNow();
  const rows: OpsStaleJob[] = [];
  const open = f.live.jobs.filter((j) => j.status === "blocked" || j.status === "claimed").sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  const settled = open.find((j) => j.status === "blocked");
  for (const j of open) {
    const days = Math.floor((now - Date.parse(j.updated_at)) / 86_400_000);
    const base = { id: j.id, namespace: j.namespace, title: j.title, status: j.status, updated_at: j.updated_at };
    if (j === settled) rows.push({ ...base, rule: "prs-settled", reason: `blocked, and every pull request it names is settled (1 merged, 0 closed without merging, read ${new Date(now - 240_000).toISOString()})` });
    else if (days >= 3) rows.push({ ...base, rule: "unchanged", reason: `${j.status} and unchanged since ${j.updated_at} (${days} day${days === 1 ? "" : "s"})` });
  }
  return { generated: new Date(now).toISOString(), rows, truncated: false, note: null };
}

// GET /portal/api/convergence: each site with an operator configuration, as the Worker
// would read it live. pages-drift fails until a sync_pages repair is performed here, so the
// Run repair journey can be seen to settle it.
function convergence(st: MockState): PortalConvergence {
  const now = mockNow();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const sites: ConvergenceSite[] = st.sites
    .filter((s) => s.origin && s.operator)
    .map((s) => {
      const op = s.operator!;
      const repaired = st.repairs.some((r) => r.namespace === s.namespace && r.tool === "sync_pages");
      const recent = [
        ...st.repairs.filter((r) => r.namespace === s.namespace).map((r) => ({ at: r.at, actor: "access:admin@example.com", tool: r.tool, via: "portal", converged: true, error: null })),
        { at: iso(26 * 3_600_000), actor: "agent:watcher", tool: "sync_ask", via: "watcher", converged: true, error: null },
      ];
      return {
        namespace: s.namespace,
        name: s.name,
        origin: s.origin!,
        read_at: new Date(now).toISOString(),
        operator: { path: op.path, auth_var: op.auth_var, secret_set: true, repairs: op.repairs, weekly: op.weekly },
        problem: null,
        status: {
          ok: true,
          error: null,
          fields: [
            { key: "headSha", value: "9c1e2f0a7b3d" },
            { key: "artifactPosts", value: "42" },
            { key: "d1Posts", value: "42" },
            { key: "d1PubliclyVisible", value: "40" },
            { key: "searchIndexDocs", value: "42" },
            { key: "askConfigured", value: "true" },
            { key: "divergences", value: "none" },
          ],
        },
        health: {
          ok: repaired,
          http_status: repaired ? 200 : 503,
          error: null,
          checks: [
            { name: "content-drift", ok: true, detail: null, expected: 42, present: 42, repair: "sync_posts", repair_refusal: null },
            { name: "pages-drift", ok: repaired, detail: repaired ? null : "2 pages differ from their files", expected: 14, present: repaired ? 14 : 12, repair: "sync_pages", repair_refusal: null },
            { name: "ask-index-drift", ok: true, detail: null, expected: 61, present: 61, repair: "sync_ask", repair_refusal: null },
            { name: "media-backup-drift", ok: true, detail: null, expected: 120, present: 120, repair: null, repair_refusal: null },
          ],
        },
        secrets: {
          state: "ok",
          script: s.script ?? s.namespace,
          reason: null,
          rows: [
            { name: "GITHUB_TOKEN", set: true, expected: true },
            { name: "OPERATOR_TOKEN", set: true, expected: true },
            { name: "SMOKE_TOKEN", set: false, expected: true },
            { name: "LEGACY_KEY", set: true, expected: false },
          ],
        },
        recent,
      };
    });
  return { generated: new Date(now).toISOString(), sites };
}

// GET /portal/api/maintenance: one row per kind of finding the daily pass makes, the job
// rows naming the feed's own jobs so they open a drawer. WF_MOCK=no-snapshot answers as
// before the first pass.
function maintenance(f: OpsFeed): PortalMaintenance {
  const now = mockNow();
  if (process.env.WF_MOCK === "no-snapshot") return { generated: null, items: [], read: { prs: 0, branches: 0, repos: 0, roster: 7, deploys: 0, disk: 0 } };
  // The sample feed has both; a feed without one fails here, not with a made-up id.
  const queued = f.live.jobs.find((j) => j.status === "queued")!.id;
  const blocked = f.live.jobs.find((j) => j.status === "blocked")!.id;
  const pr = "https://github.com/example-org/sample/pull/41";
  return {
    generated: new Date(now - 3 * 3_600_000).toISOString(),
    items: [
      { rule: "auto-resumed", namespace: "sample", job: blocked, line: `${blocked} was resumed because its pull requests merged: its holder confirms the deploy and completes it.` },
      { rule: "pr-awaiting-seat", namespace: "sample", job: blocked, pr, line: `${pr} (${blocked}) is green and has been open 2.1 days: merge it or say why it waits.` },
      { rule: "undeployed-merge", namespace: "sample-b", job: null, line: "sample-b was last deployed 2026-10-04 09:00 UTC, 4.0 days before example-org/sample-b's last commit on main (1a2b3c4): deploy it, or say why it waits." },
      { rule: "disk-low", namespace: "sample", job: queued, line: `agent:sample-driver reported 22.5 GB free at ${new Date(now - 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")} UTC, under 30 GB: run disk-guard cleanup or free space on that machine.` },
      { rule: "later-passed", namespace: "sample", job: queued, line: `${queued} is queued as LATER 2026-10-01, a date that has passed: re-title it or work it.` },
      { rule: "branch-merged", namespace: "sample", job: null, line: "3 merged branch(es) in example-org/sample would be pruned; the auto-prune is off, so none was deleted." },
      { rule: "branch-stale", namespace: "sample-c", job: null, line: "example-org/sample-c branch feat/old-idea has had no commit for 41 days (no pull request): delete it, open its pull request, or keep-list it." },
      { rule: "deploys-not-checked", namespace: "sample-c", job: null, line: "Deploys in sample-c were not checked (Cloudflare was not read for it (CF_OPS_TOKEN is not set)): what is missing is not a clean result." },
    ],
    read: { prs: 6, branches: 48, repos: 7, roster: 7, deploys: 2, disk: 2 },
  };
}

function namespaces(f: OpsFeed, st: MockState): PortalNamespaces {
  const now = mockNow();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const H = 3_600_000;
  const detail: Record<string, Partial<PortalNamespace>> = {
    sample: {
      anchor_pinned: true,
      best: { sha: "a1b2c3d4e5f6a7b8c9d0", score: 0.912, recorded_at: iso(30 * H) },
      last_run: { status: "done", started: iso(5 * H), attempts: 4, kept: 1, reverts: 3 },
      totals: { runs: 38, attempts: 152, kept: 14, reverts: 9, cost_usd: 11.2, ci_minutes: 140 },
      latest_report: { integrity: 0.93, generated: iso(26 * H) },
      skills: { candidate: 2, live: 5, retired: 1, offered: 40, used: 23, use_rate: 0.575, last_evaluation: iso(50 * H) },
    },
    "sample-b": {
      anchor_problem: "The anchor sha 9f8e7d6 is not on the default branch of example-org/sample-b.",
      best: { sha: "0f1e2d3c4b5a69788796", score: 0.71, recorded_at: iso(90 * H) },
      last_run: { status: "failed", started: iso(20 * H), attempts: 2, kept: 0, reverts: 2 },
      totals: { runs: 12, attempts: 40, kept: 6, reverts: 11, cost_usd: 4.9, ci_minutes: 52 },
      skills: { candidate: 1, live: 2, retired: 0, offered: 6, used: 1, use_rate: 1 / 6, last_evaluation: null },
    },
    "sample-c": {
      anchor_pinned: true,
      last_run: { status: "done", started: iso(80 * H), attempts: 1, kept: 0, reverts: 1 },
      totals: { runs: 3, attempts: 5, kept: 2, reverts: 3, cost_usd: 1.1, ci_minutes: 14 },
      latest_report: { integrity: null, generated: iso(70 * H) },
    },
  };
  const empty: PortalNamespace = {
    namespace: "",
    paused: null,
    anchor_pinned: false,
    anchor_problem: null,
    best: null,
    last_run: null,
    totals: { runs: 0, attempts: 0, kept: 0, reverts: 0, cost_usd: 0, ci_minutes: 0 },
    latest_report: null,
    jobs: { queued: 0, claimed: 0, blocked: 0, done_today: 0 },
    skills: { candidate: 0, live: 0, retired: 0, offered: 0, used: 0, use_rate: null, last_evaluation: null },
    breaker: { open: false, failed: 0, threshold: 3, since: "", reset_at: null },
  };
  const since = new Date(now - 24 * H).toISOString().slice(0, 19).replace("T", " ");
  const breaker = (ns: string): PortalNamespace["breaker"] =>
    BREAKER_OPEN.includes(ns) && !st.breakerReset.has(ns)
      ? { open: true, failed: 3, threshold: 3, since, reset_at: null }
      : { open: false, failed: 0, threshold: 3, since, reset_at: st.breakerReset.has(ns) ? new Date(now).toISOString() : null };
  return {
    generated: new Date(now).toISOString(),
    namespaces: f.live.namespaces.map((n) => {
      const js = f.live.jobs.filter((j) => j.namespace === n.name);
      const count = (s: OpsJob["status"]) => js.filter((j) => j.status === s).length;
      return { ...empty, ...detail[n.name], namespace: n.name, paused: n.paused, breaker: breaker(n.name), jobs: { queued: count("queued"), claimed: count("claimed"), blocked: count("blocked"), done_today: count("done") } };
    }),
  };
}

function seedActivity(): PortalActivityRow[] {
  const now = mockNow();
  const M = 60_000;
  // A job transition writes two rows with one action, actor, path and second, one for
  // the job and one for its mirror document, as the Worker does (src/portal-activity.ts).
  // What each row recorded, by name, as src/audit-detail.ts reads it from the params.
  const none = { reason: null, changes: null, fields: [], withheld: 0, unreadable: false };
  const d = (over: Partial<PortalActivityRow["detail"]>): PortalActivityRow["detail"] => ({ ...none, ...over });
  const rows: Array<[number, string | null, string | null, string | null, string | null, PortalActivityRow["target"], PortalActivityRow["detail"]]> = [
    [4, "agent:sample-driver", "write", "sample", "sample/notes/run-log.md", "document", d({ fields: [{ name: "Mode", value: "append" }], withheld: 1 })],
    [11, "agent:watcher", "job-posted", "sample-b", "jobs/job_9ab0bcf483ae.md", "job", d({ fields: [{ name: "Job", value: "job_9ab0bcf483ae" }, { name: "Priority", value: "40" }] })],
    [11, "agent:watcher", "job-posted", "sample-b", "jobs/job_9ab0bcf483ae.md", "document", d({ withheld: 1 })],
    [26, "agent:sample-driver", "jobs.block", "sample", "sample/jobs/job_7c1e44b0a912.md", "job", d({ reason: "The push is ready for the seat.", fields: [{ name: "Job", value: "job_7c1e44b0a912" }, { name: "Status", value: "blocked" }] })],
    [48, "seat", "jobs.resume", "sample", "sample/jobs/job_91b3c0de5a24.md", "job", d({ reason: "Merged #41 and confirmed the deploy.", fields: [{ name: "Job", value: "job_91b3c0de5a24" }] })],
    [70, ACTOR, "ops-site-edited", "sample-b", null, null, d({ changes: [{ field: "Origin", before: "https://sample-b.example.com", after: "https://www.sample-b.example.com" }, { field: "Health path", before: "none", after: "/health" }, { field: "Revision", before: "3", after: "4" }] })],
    [95, "agent:sample-b-driver", "write", "sample-b", "sample-b/core.md", "document", d({ fields: [{ name: "Mode", value: "overwrite" }], withheld: 1 })],
    [180, ACTOR, "portal-mode", null, null, null, d({ reason: "Nightly runs are paused while the budget resets.", fields: [{ name: "Mode", value: "off" }] })],
    [240, "agent:reviewer", "read", "sample-c", "sample-c/decisions.md", null, d({})],
    [400, null, "lint.finalize", "sample", "sample/archive/old-note.md", null, d({ unreadable: true })],
    [720, "agent:sample-c-driver", "improve.run", "sample-c", null, null, d({ fields: [{ name: "Ran", value: "yes" }, { name: "Note", value: "baseline scored" }] })],
  ];
  return rows.map(([m, actor, action, namespace, path, target, detail], i) => ({ id: 1000 - i, at: new Date(now - m * M).toISOString(), actor, action, namespace, path, target, detail }));
}

// The Worker's own cap (ACTIVITY_LIMIT in src/portal-activity.ts), so the screenshots
// state what the Portal reads.
const ACTIVITY_LIMIT = 50;

// Claims, with fake data only: per-agent groups for the aggregate, and two jobs from the
// fixture with their claims, checks and touches for the drill-in. Any other job id is
// the Worker's JSON 404.
type ClaimRow = PortalClaimsJob["claims"][number];
type EvaluationRow = PortalClaimsJob["evaluations"][number];

function seedClaimGroups(): ClaimsGroup[] {
  const touches = (count: number, byKind: Record<string, number>, byActor: Record<string, number>, waits: number[]): ClaimsGroup["touches"] => {
    const sorted = [...waits].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length === 0 ? null : sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    return { count, by_kind: byKind, by_actor_kind: byActor, waits: waits.length, waited_ms_total: waits.length ? waits.reduce((a, b) => a + b, 0) : null, waited_ms_median: median };
  };
  const agr = (agree: number, disagree: number, unclaimed: number, unchecked: number) => ({ agree, disagree, unclaimed, unchecked });
  return [
    {
      agent: "agent:sample-b-driver",
      namespace: "sample-b",
      jobs: 3,
      claims: 4,
      evaluations: { pr_merged: agr(2, 0, 0, 0), prs_opened: agr(2, 0, 0, 0), commits: agr(1, 1, 0, 0), files_changed: agr(2, 0, 0, 0), ci_green: agr(0, 0, 2, 0) },
      touches: touches(3, { gate: 1, approval: 1, note: 1 }, { human: 2, seat: 1 }, [2_700_000]),
    },
    {
      agent: "agent:sample-c-driver",
      namespace: "sample-c",
      jobs: 2,
      claims: 2,
      evaluations: { pr_merged: agr(0, 1, 0, 0), prs_opened: agr(1, 0, 0, 0), commits: agr(0, 0, 1, 0), files_changed: agr(0, 0, 0, 1), ci_green: agr(0, 0, 1, 0) },
      touches: touches(1, { admin_fail: 1 }, { seat: 1 }, []),
    },
    {
      agent: "agent:sample-driver",
      namespace: "sample",
      jobs: 5,
      claims: 8,
      evaluations: { pr_merged: agr(3, 1, 0, 0), prs_opened: agr(4, 0, 0, 0), commits: agr(2, 1, 1, 0), files_changed: agr(3, 0, 0, 1), ci_green: agr(0, 0, 4, 0) },
      touches: touches(6, { gate: 3, approval: 2, correction: 1 }, { human: 4, policy: 1, seat: 1 }, [540_000, 11_520_000, 1_800_000]),
    },
    {
      agent: null,
      namespace: "sample-f",
      jobs: 0,
      claims: 0,
      evaluations: {},
      touches: touches(1, { release: 1 }, { seat: 1 }, []),
    },
  ];
}

function seedClaimJobs(): Map<string, Omit<PortalClaimsJob, "generated">> {
  const now = mockNow();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const claim = (id: number, jobId: string, action: ClaimRow["action"], minutesAgo: number, over: Partial<ClaimRow> = {}): ClaimRow => ({
    id,
    job_id: jobId,
    action,
    agent: "agent:sample-driver",
    namespace: "sample",
    raw: "{}",
    prs_opened_urls: null,
    prs_merged_urls: null,
    prs_opened: null,
    prs_merged: null,
    commits: null,
    files_changed: null,
    tests_added: null,
    tests_run: null,
    tests_passed: null,
    tests_failed: null,
    tests_result: null,
    deploy_state: null,
    files_touched: null,
    model_id: null,
    client_name: null,
    client_version: null,
    permission_mode: null,
    capsid_sha: SHA,
    recorded_at: at(minutesAgo),
    ...over,
  });
  const PR = "https://github.com/example/sample/pull/41";
  const done = "job_6b5a4c3d2e1f";
  const blocked = "job_7c1e44b0a912";
  const evaluation = (
    id: number,
    name: string,
    claimed: string | null,
    verified: string | null,
    agreement: EvaluationRow["agreement"],
    label: EvaluationRow["score_label"],
    value: number | null
  ): EvaluationRow => ({
    id,
    job_id: done,
    claim_id: 3,
    name,
    score_value: value,
    score_label: label,
    claimed,
    verified,
    agreement,
    evaluator: "worker",
    evaluator_id: `capsid@${SHA}`,
    explanation: null,
    recorded_at: at(95),
  });
  return new Map<string, Omit<PortalClaimsJob, "generated">>([
    [
      done,
      {
        job: { id: done, namespace: "sample", title: "Record the login switch dates in the auth doc", status: "done", claimed_by: "agent:sample-driver" },
        outcome: {
          job_id: done,
          agent: "agent:sample-driver",
          namespace: "sample",
          prs_opened: 1,
          prs_merged: 1,
          commits: 2,
          files_changed: 1,
          tests_added: null,
          ci_green: null,
          blocked_count: 1,
          resumed_count: 1,
          duration_minutes: 34,
          result_kind: "pr",
          verified: '{"prs_opened":true,"prs_merged":true,"commits":true,"files_changed":true,"ci_green":false}',
          recorded_at: at(95),
        },
        claims: [
          claim(2, done, "block", 190, { raw: '{"reason":"needs a push","command":"git push -u origin docs/auth-dates"}' }),
          claim(3, done, "complete", 95, {
            raw: `{"evidence":{"prs":["${PR}"],"commits":3,"files_changed":1},"claim":{"prs_merged":["${PR}"],"tests":{"result":"not_run"},"deploy_state":"none"}}`,
            prs_opened_urls: `["${PR}"]`,
            prs_merged_urls: `["${PR}"]`,
            prs_opened: 1,
            prs_merged: 1,
            commits: 3,
            files_changed: 1,
            tests_result: "not_run",
            deploy_state: "none",
            files_touched: '["docs/auth.md"]',
            model_id: "sample-model",
            client_name: "sample-client",
            client_version: "1.0.0",
            permission_mode: "default",
          }),
        ],
        evaluations: [
          evaluation(1, "pr_merged", "1", "1", "agree", "pass", 1),
          evaluation(2, "prs_opened", "1", "1", "agree", "pass", 1),
          evaluation(3, "commits", "3", "2", "disagree", "pass", 2),
          evaluation(4, "files_changed", "1", "1", "agree", "pass", 1),
          evaluation(5, "ci_green", null, null, "unclaimed", "unknown", null),
        ],
        touches: [
          { id: 1, job_id: done, namespace: "sample", kind: "gate", actor: "agent:sample-driver", actor_kind: "driver", waited_ms: null, detail: '{"reason":"needs a push","command":"git push -u origin docs/auth-dates"}', at: at(190) },
          { id: 2, job_id: done, namespace: "sample", kind: "approval", actor: "access:admin@example.com", actor_kind: "human", waited_ms: 3_300_000, detail: '{"reason":"pushed"}', at: at(135) },
        ],
        limit: 200,
        truncated: [],
      },
    ],
    [
      blocked,
      {
        job: { id: blocked, namespace: "sample", title: "Watcher: the off-account mirror's workflow is failing [mirror-run-failed]", status: "blocked", claimed_by: "agent:sample-driver" },
        outcome: null,
        claims: [claim(1, blocked, "block", 26, { raw: '{"reason":"the workflow needs a secret","command":"gh secret set SAMPLE_KEY"}' })],
        evaluations: [],
        touches: [{ id: 3, job_id: blocked, namespace: "sample", kind: "gate", actor: "agent:sample-driver", actor_kind: "driver", waited_ms: null, detail: '{"reason":"the workflow needs a secret"}', at: at(26) }],
        limit: 200,
        truncated: [],
      },
    ],
  ]);
}

// The Worker's since and until check: an ISO date or time, or it is a 400.
function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) && !Number.isNaN(parsed) ? new Date(parsed).toISOString() : "bad";
}

export function mockOpsApi(): Plugin {
  let nextRefresh = 0;
  const st: MockState = { paused: new Map(), breakerReset: new Set(), mode: null, seat: null, overnight: null, overnightReason: "", jobs: new Map(), revoked: new Map(), sites: seedSites(), packages: seedPackages(), activity: seedActivity(), canonDecided: new Set(), repairs: [], tokens: new Map() };
  const csrf = () => fixture().csrf;
  const claimGroups = seedClaimGroups();
  const claimJobs = seedClaimJobs();

  async function action(req: IncomingMessage, res: ServerResponse, kind: "preview" | "perform"): Promise<void> {
    if (req.method !== "POST") return refuse(res, 400, "This endpoint takes POST.");
    if (req.headers["x-capsid-csrf"] !== csrf()) return refuse(res, 403, "The X-Capsid-CSRF header is missing or does not match. Reload the page and try again.");
    if (!(req.headers["content-type"] ?? "").includes("application/json")) return refuse(res, 400, "The body must be JSON (Content-Type: application/json).");
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof Refusal) return refuse(res, e.status, e.message);
      return refuse(res, 400, `The body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const f = feed(nextRefresh, st);
    try {
      if (kind === "preview") {
        const b = body as { action?: unknown; params?: unknown };
        const a = b.action as PortalAction;
        if (!ACTIONS.includes(a)) throw new Refusal(400, `Unknown action: ${String(b.action)}.`);
        const params = b.params && typeof b.params === "object" ? (b.params as Record<string, string>) : {};
        const p = plan(f, a, params);
        const token = randomUUID();
        const expires = mockNow() + TOKEN_MS;
        st.tokens.set(token, { action: a, params, expires });
        const out: PortalPreview = { action: a, summary: p.summary, changes: p.changes, audit: [`${clickName(a, params)} by ${ACTOR}`], token, expires_at: new Date(expires).toISOString() };
        return send(res, 200, out);
      }
      const token = (body as { token?: unknown }).token;
      if (typeof token !== "string" || !token) throw new Refusal(400, "The token is missing.");
      const t = st.tokens.get(token);
      if (!t) throw new Refusal(400, "The token is not one this server issued, or it was already used.");
      if (process.env.WF_MOCK === "expired" || t.expires < mockNow()) {
        st.tokens.delete(token);
        throw new Refusal(410, "This confirmation expired. Preview the action again.");
      }
      st.tokens.delete(token);
      const p = plan(f, t.action, t.params);
      p.apply(st);
      const ns = t.params.namespace ?? f.live.jobs.find((j) => j.id === t.params.id)?.namespace ?? null;
      const { reason, ...named } = t.params;
      st.activity.unshift({
        id: (st.activity[0]?.id ?? 0) + 1,
        target: null,
        at: new Date(mockNow()).toISOString(),
        actor: ACTOR,
        action: clickName(t.action, t.params),
        namespace: ns,
        path: t.params.id ? `${ns}/jobs/${t.params.id}.md` : null,
        detail: { reason: reason ?? null, changes: null, fields: Object.entries(named).map(([k, v]) => ({ name: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "), value: v })), withheld: 0, unreadable: false },
      });
      const out: PortalPerformed = { action: t.action, summary: p.done, warning: process.env.WF_MOCK === "warn" ? "The action happened, but its audit row was not written." : null, feed: feed(nextRefresh, st) };
      return send(res, 200, out);
    } catch (e) {
      if (e instanceof Refusal) return refuse(res, e.status, e.message);
      throw e;
    }
  }

  const handle = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const known = ["/portal/api/ops", "/portal/api/ops/refresh", "/portal/api/actions/preview", "/portal/api/actions/perform", "/portal/api/namespaces", "/portal/api/activity", "/portal/api/claims", "/portal/api/packages/history", "/portal/api/stale", "/portal/api/maintenance", "/portal/api/convergence", "/portal/api/sign-out"];
        if (!known.includes(path)) return next();
        if (process.env.WF_MOCK === "signed-out") return send(res, 401, { error: "signed out" });
        if (path === "/portal/api/ops") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          return send(res, 200, feed(nextRefresh, st));
        }
        if (path === "/portal/api/actions/preview" || path === "/portal/api/actions/perform") {
          // An unexpected error goes to Vite's error handler, which answers 500 with it.
          action(req, res, path.endsWith("preview") ? "preview" : "perform").catch(next);
          return;
        }
        if (path === "/portal/api/namespaces") return send(res, 200, namespaces(feed(nextRefresh, st), st));
        if (path === "/portal/api/stale") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          return send(res, 200, stale(feed(nextRefresh, st)));
        }
        if (path === "/portal/api/convergence") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          return send(res, 200, convergence(st));
        }
        if (path === "/portal/api/maintenance") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          return send(res, 200, maintenance(feed(nextRefresh, st)));
        }
        if (path === "/portal/api/sign-out") {
          if (req.method !== "POST") return send(res, 405, { error: "method" });
          if (req.headers["x-capsid-csrf"] !== csrf()) return refuse(res, 403, "csrf validation failed: reload Capsid Portal and try again.");
          res.statusCode = 204;
          return res.end();
        }
        if (path === "/portal/api/activity") {
          const namespace = url.searchParams.get("namespace") || null;
          const actor = url.searchParams.get("actor") || null;
          const rawId = url.searchParams.get("id");
          if (rawId !== null && !/^[1-9][0-9]{0,15}$/.test(rawId)) return refuse(res, 400, `id must be an audit row id, a positive whole number; got ${JSON.stringify(rawId)}.`);
          const id = rawId === null ? null : Number(rawId);
          const rows = (id !== null ? st.activity.filter((r) => r.id === id) : st.activity.filter((r) => (!namespace || r.namespace === namespace) && (!actor || r.actor === actor))).slice(0, ACTIVITY_LIMIT);
          const out: PortalActivity = { generated: new Date(mockNow()).toISOString(), filter: { namespace, actor, id }, rows, limit: ACTIVITY_LIMIT };
          return send(res, 200, out);
        }
        if (path === "/portal/api/packages/history") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          const name = url.searchParams.get("name")?.trim() ?? "";
          const p = st.packages.find((x) => x.name === name);
          if (!p) return send(res, 404, { error: `${name} is not a configured package.` });
          return send(res, 200, mockHistory(p));
        }
        if (path === "/portal/api/claims") {
          if (req.method !== "GET") return send(res, 405, { error: "method" });
          const job = url.searchParams.get("job")?.trim();
          if (job) {
            const found = claimJobs.get(job);
            if (!found) return send(res, 404, { error: `no job ${job}` });
            const out: PortalClaimsJob = { generated: new Date(mockNow()).toISOString(), ...found };
            return send(res, 200, out);
          }
          const namespace = url.searchParams.get("namespace")?.trim() || null;
          const agent = url.searchParams.get("agent")?.trim() || null;
          const since = isoOrNull(url.searchParams.get("since"));
          const until = isoOrNull(url.searchParams.get("until"));
          if (since === "bad" || until === "bad") return refuse(res, 400, "since and until must be ISO 8601 times such as 2026-09-01.");
          const groups = claimGroups.filter((g) => (!namespace || g.namespace === namespace) && (!agent || g.agent === agent));
          const out: PortalClaimsAggregate = { generated: new Date(mockNow()).toISOString(), filter: { namespace, agent, since, until }, groups, waits: [], usage: [], truncated: [] };
          return send(res, 200, out);
        }
        if (req.method !== "POST" || req.headers["x-capsid-ops"] !== "refresh") return send(res, 400, { error: "refresh needs POST and X-Capsid-Ops: refresh" });
        if (mockNow() < nextRefresh) {
          return send(res, 429, { error: "too soon", refresh_allowed_at: new Date(nextRefresh).toISOString() });
        }
        nextRefresh = mockNow() + REFRESH_GAP_MS;
        // As the Worker does when the pass ran and its audit row was not written.
        if (process.env.WF_MOCK === "warn") res.setHeader("x-capsid-warning", "the pass ran, but the Portal audit row naming access:admin@example.com was not written: D1 is unavailable");
        return send(res, 200, feed(nextRefresh, st));
  };

  return {
    name: "watch-floor-mock-ops",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    // `vite preview` serves the production build: the browser tests (dashboard/e2e)
    // run against it with the same mock, and with the Worker's own page CSP on every
    // response, so a script or style the Worker's page would refuse fails the tests too.
    configurePreviewServer(server) {
      server.middlewares.use((_req: IncomingMessage, res: ServerResponse, next: () => void) => {
        res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
        next();
      });
      server.middlewares.use(handle);
    },
  };
}
