// Dev and preview only: serves dev/sample-feed.json at /portal/api/ops so `npm run
// dev`, and the browser tests under `vite preview`, run with fake data and no Worker.
// Never part of the build (apply: "serve").
//
// The fixture's timestamps are fixed; each response shifts every ISO timestamp and
// ring_slot so live.generated is "now", which keeps the relative times readable.
//
// It also mocks the Portal's controls (preview and perform), GET
// /portal/api/namespaces, GET /portal/api/activity and POST /portal/api/sign-out, with
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
import type { OpsFeed, OpsJob, OpsSiteConfig, PortalAction, PortalActivity, PortalActivityRow, PortalNamespace, PortalNamespaces, PortalPerformed, PortalPreview } from "../src/types.ts";

const FIXTURE = fileURLToPath(new URL("./sample-feed.json", import.meta.url));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SLOT_MS = 30 * 60_000;
const REFRESH_GAP_MS = 30_000;
const TOKEN_MS = 5 * 60_000;
const MAX_BODY = 8 * 1024;
const ACTOR = "admin@example.com";
const ACTIONS: PortalAction[] = ["pause", "unpause", "mode", "seat_start", "resume_job", "release_job", "fail_job", "revoke_agent", "site_add", "site_edit", "site_remove"];
// Registered in the mock but with no site row, so an add has somewhere to go. The site
// map in the fixture reports it as unmapped.
const EXTRA_REGISTERED = ["sample-i"];

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
  mode: string | null;
  seat: boolean | null;
  jobs: Map<string, Partial<OpsJob>>;
  revoked: Map<string, string>;
  // The site configuration as it stands, every row, by namespace.
  sites: OpsSiteConfig[];
  activity: PortalActivityRow[];
  tokens: Map<string, { action: PortalAction; params: Record<string, string>; expires: number }>;
}

function fixture(): OpsFeed {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  const delta = Date.now() - Date.parse(raw.live.generated);
  return shift(raw, delta) as OpsFeed;
}

// D1's datetime('now') shape, which is what the Worker sends for updated_at.
function sqlNow(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

// The fixture's rows, with updated_at shifted as fixture() shifts the ISO timestamps
// (it is D1's shape, not ISO, so shift() leaves it alone). WF_MOCK=no-sites starts empty.
function seedSites(): OpsSiteConfig[] {
  if (process.env.WF_MOCK === "no-sites") return [];
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as OpsFeed;
  const delta = Date.now() - Date.parse(raw.live.generated);
  return raw.live.sites.map((s) => ({ ...s, updated_at: sqlNow(Date.parse(`${s.updated_at.replace(" ", "T")}Z`) + delta) }));
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
  out.live.jobs = out.live.jobs.map((j) => ({ ...j, ...st.jobs.get(j.id) }));
  for (const a of out.live.agents) if (st.revoked.has(a.name)) a.revoked_at = st.revoked.get(a.name) ?? null;
  out.live.sites = st.sites.map((s) => ({ ...s }));
  out.refresh_allowed_at = nextRefresh > Date.now() ? new Date(nextRefresh).toISOString() : null;
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
  const now = new Date().toISOString();
  const job = () => {
    const id = need(params, "id", "The job id");
    const j = f.live.jobs.find((x) => x.id === id);
    if (!j) throw new Refusal(400, `No job ${id}.`);
    return j;
  };
  switch (action) {
    case "pause": {
      const ns = need(params, "namespace", "The namespace");
      const reason = need(params, "reason", "A reason");
      const n = f.live.namespaces.find((x) => x.name === ns);
      if (!n) throw new Refusal(400, `${ns} is not a roster namespace.`);
      if (n.paused != null) throw new Refusal(400, `${ns} is already paused: ${n.paused}`);
      return { summary: `Pause the improve loop for ${ns}.`, done: `Paused the improve loop for ${ns}.`, changes: [`improve:paused:${ns}: not set -> "${reason}"`, "The next scheduled run for this namespace is skipped."], apply: (st) => void st.paused.set(ns, reason) };
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
        changes: [`jobs.${j.id}.status: blocked -> queued`, `jobs.${j.id}.resumed_count: ${j.resumed_count} -> ${j.resumed_count + 1}`],
        apply: (st) => void st.jobs.set(j.id, { status: "queued", waits_on: null, command: null, claimed_by: null, lease_expires: null, resumed_count: j.resumed_count + 1, updated_at: now }),
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
          st.sites.push({ ...site, self_probe: false, revision: 1, updated_at: sqlNow() });
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
  }
}

function namespaces(f: OpsFeed): PortalNamespaces {
  const now = Date.now();
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
  };
  return {
    generated: new Date(now).toISOString(),
    namespaces: f.live.namespaces.map((n) => {
      const js = f.live.jobs.filter((j) => j.namespace === n.name);
      const count = (s: OpsJob["status"]) => js.filter((j) => j.status === s).length;
      return { ...empty, ...detail[n.name], namespace: n.name, paused: n.paused, jobs: { queued: count("queued"), claimed: count("claimed"), blocked: count("blocked"), done_today: count("done") } };
    }),
  };
}

function seedActivity(): PortalActivityRow[] {
  const now = Date.now();
  const M = 60_000;
  // A job transition writes two rows with one action, actor, path and second, one for
  // the job and one for its mirror document, as the Worker does (src/portal-activity.ts).
  const rows: Array<[number, string | null, string | null, string | null, string | null, PortalActivityRow["target"]]> = [
    [4, "agent:sample-driver", "write", "sample", "sample/notes/run-log.md", "document"],
    [11, "agent:watcher", "job-posted", "sample-b", "jobs/job_9ab0bcf483ae.md", "job"],
    [11, "agent:watcher", "job-posted", "sample-b", "jobs/job_9ab0bcf483ae.md", "document"],
    [26, "agent:sample-driver", "jobs.block", "sample", "sample/jobs/job_7c1e44b0a912.md", "job"],
    [48, "seat", "jobs.resume", "sample", "sample/jobs/job_91b3c0de5a24.md", "job"],
    [95, "agent:sample-b-driver", "write", "sample-b", "sample-b/core.md", "document"],
    [180, ACTOR, "portal.mode", null, null, null],
    [240, "agent:reviewer", "read", "sample-c", "sample-c/decisions.md", null],
    [400, null, "lint.finalize", "sample", "sample/archive/old-note.md", null],
    [720, "agent:sample-c-driver", "improve.run", "sample-c", null, null],
  ];
  return rows.map(([m, actor, action, namespace, path, target], i) => ({ id: 1000 - i, at: new Date(now - m * M).toISOString(), actor, action, namespace, path, target }));
}

const ACTIVITY_LIMIT = 200;

export function mockOpsApi(): Plugin {
  let nextRefresh = 0;
  const st: MockState = { paused: new Map(), mode: null, seat: null, jobs: new Map(), revoked: new Map(), sites: seedSites(), activity: seedActivity(), tokens: new Map() };
  const csrf = () => fixture().csrf;

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
        const expires = Date.now() + TOKEN_MS;
        st.tokens.set(token, { action: a, params, expires });
        const out: PortalPreview = { action: a, summary: p.summary, changes: p.changes, audit: [`portal.${a} by ${ACTOR}`], token, expires_at: new Date(expires).toISOString() };
        return send(res, 200, out);
      }
      const token = (body as { token?: unknown }).token;
      if (typeof token !== "string" || !token) throw new Refusal(400, "The token is missing.");
      const t = st.tokens.get(token);
      if (!t) throw new Refusal(400, "The token is not one this server issued, or it was already used.");
      if (process.env.WF_MOCK === "expired" || t.expires < Date.now()) {
        st.tokens.delete(token);
        throw new Refusal(410, "This confirmation expired. Preview the action again.");
      }
      st.tokens.delete(token);
      const p = plan(f, t.action, t.params);
      p.apply(st);
      const ns = t.params.namespace ?? f.live.jobs.find((j) => j.id === t.params.id)?.namespace ?? null;
      st.activity.unshift({ id: (st.activity[0]?.id ?? 0) + 1, target: null, at: new Date().toISOString(), actor: ACTOR, action: `portal.${t.action}`, namespace: ns, path: t.params.id ? `${ns}/jobs/${t.params.id}.md` : null });
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
        const known = ["/portal/api/ops", "/portal/api/ops/refresh", "/portal/api/actions/preview", "/portal/api/actions/perform", "/portal/api/namespaces", "/portal/api/activity", "/portal/api/sign-out"];
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
        if (path === "/portal/api/namespaces") return send(res, 200, namespaces(feed(nextRefresh, st)));
        if (path === "/portal/api/sign-out") {
          if (req.method !== "POST") return send(res, 405, { error: "method" });
          if (req.headers["x-capsid-csrf"] !== csrf()) return refuse(res, 403, "csrf validation failed: reload Capsid Portal and try again.");
          res.statusCode = 204;
          return res.end();
        }
        if (path === "/portal/api/activity") {
          const namespace = url.searchParams.get("namespace") || null;
          const actor = url.searchParams.get("actor") || null;
          const rows = st.activity.filter((r) => (!namespace || r.namespace === namespace) && (!actor || r.actor === actor)).slice(0, ACTIVITY_LIMIT);
          const out: PortalActivity = { generated: new Date().toISOString(), filter: { namespace, actor }, rows, limit: ACTIVITY_LIMIT };
          return send(res, 200, out);
        }
        if (req.method !== "POST" || req.headers["x-capsid-ops"] !== "refresh") return send(res, 400, { error: "refresh needs POST and X-Capsid-Ops: refresh" });
        if (Date.now() < nextRefresh) {
          return send(res, 429, { error: "too soon", refresh_allowed_at: new Date(nextRefresh).toISOString() });
        }
        nextRefresh = Date.now() + REFRESH_GAP_MS;
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
