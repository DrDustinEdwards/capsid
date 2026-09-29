import type { CiObservation, OpsAgent, OpsFeed, OpsJob, OpsSnapshot, ProbeState, SiteCloudflare, SiteSnapshot } from "../types";
import { DAY, HOUR, SLOT_MS, age, ago, hostOf, ms } from "./format";

// The status vocabulary: every state is a shape, a word and a colour.
export type Kind = "ok" | "warn" | "crit" | "nodata" | "run" | "queued" | "blocked" | "done";

export const PROBE: Record<ProbeState, { kind: Kind; label: string }> = {
  ok: { kind: "ok", label: "Up" },
  degraded: { kind: "warn", label: "Degraded" },
  liveness: { kind: "nodata", label: "Liveness only" },
  down: { kind: "crit", label: "Down" },
};

export function siteKey(s: SiteSnapshot): string {
  return s.name;
}

// Why a site has no Cloudflare numbers. Every state but "ok" is no data, never zero.
export function cfNoData(cf: SiteCloudflare | undefined): string | null {
  if (!cf) return "Not read on this pass (the snapshot predates the Cloudflare read)";
  if (cf.state === "ok") return null;
  if (cf.state === "no-token") return "Cloudflare read not configured";
  return cf.reason;
}

export function cfOk(s: SiteSnapshot) {
  return s.cloudflare?.state === "ok" ? s.cloudflare : null;
}

// ---- probe ring -------------------------------------------------------------

export const RING_SLOTS = 336;

// The ring padded on the left to 7 days of half-hour slots, oldest first.
export function ringOf(s: SiteSnapshot): string {
  const r = s.ring.slice(-RING_SLOTS);
  return "-".repeat(RING_SLOTS - r.length) + r;
}

// Start time of slot i (0 oldest) of a padded ring.
export function slotStart(s: SiteSnapshot, i: number): number {
  return (s.ring_slot - (RING_SLOTS - 1 - i)) * SLOT_MS;
}

export function uptime(ring: string): number | null {
  let up = 0;
  let seen = 0;
  for (const c of ring) {
    if (c === "1") (up++, seen++);
    else if (c === "0") seen++;
  }
  return seen ? up / seen : null;
}

// ---- jobs -------------------------------------------------------------------

export const JOB: Record<OpsJob["status"], { kind: Kind; label: string }> = {
  queued: { kind: "queued", label: "Queued" },
  claimed: { kind: "run", label: "Running" },
  blocked: { kind: "blocked", label: "Blocked" },
  done: { kind: "done", label: "Done" },
  failed: { kind: "crit", label: "Failed" },
  superseded: { kind: "nodata", label: "Superseded" },
};

export const OPEN_STATUSES: ReadonlyArray<OpsJob["status"]> = ["queued", "claimed", "blocked"];

export function isOpen(j: OpsJob): boolean {
  return OPEN_STATUSES.includes(j.status);
}

export function resumeCall(j: OpsJob): string {
  return `jobs action "resume" id "${j.id}" namespace "${j.namespace}" reason "<what you did>"`;
}

// ---- CI ---------------------------------------------------------------------

const QUIET = new Set(["success", "skipped", "neutral"]);

export function ciState(c: CiObservation): { kind: Kind; label: string; red: boolean } {
  const l = c.latest;
  if (!l) return { kind: "nodata", label: "Could not read", red: false };
  if (l.conclusion == null) return { kind: "run", label: l.status.replace(/_/g, " "), red: false };
  if (QUIET.has(l.conclusion)) return { kind: "ok", label: l.conclusion === "success" ? "Green" : l.conclusion, red: false };
  return { kind: "crit", label: l.conclusion.replace(/_/g, " "), red: true };
}

// ---- watcher staleness --------------------------------------------------------

export function passStale(snap: OpsSnapshot | null, now: number): boolean {
  return !snap || now - ms(snap.pass_at) > 2 * snap.cadence_min * 60_000;
}

// ---- needs attention ----------------------------------------------------------

export type Sev = "crit" | "warn" | "nodata";
export type OpenRef = string; // "site:<key>" | "job:<id>" | "agent:<name>" | "view:<id>"

export interface Attention {
  sev: Sev;
  kind: string;
  title: string;
  sub: string;
  at: number;
  open: OpenRef;
}

export function attentionItems(feed: OpsFeed, now: number): Attention[] {
  const out: Attention[] = [];
  const snap = feed.snapshot;
  const live = feed.live;
  if (!snap) {
    out.push({ sev: "nodata", kind: "Watcher", title: "The watcher has not written its first pass yet", sub: "Sites, deploys, errors, backups and CI appear after the first pass", at: ms(live.generated), open: "view:incidents" });
  } else {
    if (passStale(snap, now)) {
      out.push({ sev: "warn", kind: "Watcher", title: `The last watcher pass is ${age(ms(snap.pass_at), now)} old`, sub: `It runs every ${snap.cadence_min} min; site data is stale after ${2 * snap.cadence_min} min`, at: ms(snap.pass_at), open: "view:incidents" });
    }
    for (const s of snap.sites) {
      if (s.state === "down" || s.state === "degraded") {
        out.push({
          sev: s.state === "down" ? "crit" : "warn",
          kind: "Site",
          title: `${s.name}: ${s.error ?? PROBE[s.state].label}`,
          sub: `${hostOf(s.origin)} · ${s.http_status == null ? "no answer" : `HTTP ${s.http_status}`} · checked ${ago(ms(s.checked_at), now)}`,
          at: ms(s.checked_at),
          open: `site:${siteKey(s)}`,
        });
      }
      const cf = s.cloudflare;
      if (cf && (cf.state === "error" || cf.state === "unresolved" || (cf.state === "no-token" && feed.cloudflare_configured))) {
        out.push({ sev: "nodata", kind: "Site", title: `${s.name}: no Cloudflare data`, sub: cfNoData(cf) ?? "", at: ms(snap.pass_at), open: `site:${siteKey(s)}` });
      }
    }
    const h = snap.health;
    if (!h) {
      out.push({ sev: "nodata", kind: "Backup", title: "Capsid health was not read on the last pass", sub: "Backup age is unknown", at: ms(snap.pass_at), open: "view:backups" });
    } else {
      if (h.status === "degraded") out.push({ sev: "warn", kind: "Health", title: "Capsid reports degraded health", sub: `store d1 ${h.store.d1}, fts ${h.store.fts} · sha ${h.sha.slice(0, 7)}`, at: ms(snap.pass_at), open: "view:backups" });
      if (h.backup.warning || !h.backup.last_ok) {
        out.push({ sev: "crit", kind: "Backup", title: h.backup.warning ?? "No good backup is recorded", sub: h.backup.last_ok ? `last good dump ${ago(ms(h.backup.last_ok), now)}` : "no last_ok", at: h.backup.last_ok ? ms(h.backup.last_ok) : ms(snap.pass_at), open: "view:backups" });
      }
    }
    const m = snap.mirror;
    if (!m) {
      out.push({ sev: "nodata", kind: "Backup", title: "The off-account mirror was not read on the last pass", sub: "", at: ms(snap.pass_at), open: "view:backups" });
    } else {
      const dumpAge = m.newest_dump ? now - ms(m.newest_dump) : null;
      const failed = m.last_run?.conclusion != null && m.last_run.conclusion !== "success";
      if (dumpAge == null || dumpAge > 2 * DAY || failed) {
        out.push({
          sev: "crit",
          kind: "Backup",
          title: dumpAge == null ? "The off-account mirror has no dump" : dumpAge > 2 * DAY ? `Off-account mirror has not landed a dump in ${(dumpAge / DAY).toFixed(1)} days` : `The off-account mirror's last run ended ${m.last_run?.conclusion}`,
          sub: m.last_run ? `Last run ${m.last_run.conclusion ?? "still running"}${m.last_run.at ? ` ${ago(ms(m.last_run.at), now)}` : ""}` : "No run recorded",
          at: m.last_run?.at ? ms(m.last_run.at) : ms(snap.pass_at),
          open: "view:backups",
        });
      }
    }
    for (const c of snap.ci) {
      const st = ciState(c);
      if (!c.latest) out.push({ sev: "nodata", kind: "CI", title: `CI runs for ${c.namespace} could not be read`, sub: "The GitHub read failed on the last pass", at: ms(snap.pass_at), open: "view:ci" });
      else if (st.red) out.push({ sev: "warn", kind: "CI", title: `${c.namespace} default branch is ${st.label}`, sub: `${c.latest.head_sha.slice(0, 7)} · ${c.latest.status}`, at: ms(c.latest.created_at), open: "view:ci" });
    }
    for (const c of snap.checks) {
      if (c.state === "could-not-run") out.push({ sev: "nodata", kind: "Watcher", title: `Check '${c.id}' could not run on the last pass`, sub: c.findings.join("; "), at: ms(snap.pass_at), open: "view:incidents" });
    }
    const drift = snap.site_map;
    if (drift && (drift.unmapped.length || drift.unknown.length)) {
      out.push({ sev: "nodata", kind: "Watcher", title: `Site map drift: ${drift.unmapped.length} unmapped, ${drift.unknown.length} unknown`, sub: [...drift.unmapped, ...drift.unknown].join(", "), at: ms(snap.pass_at), open: "view:incidents" });
    }
  }
  if (!feed.cloudflare_configured) {
    out.push({ sev: "nodata", kind: "Watcher", title: "Cloudflare read not configured", sub: "Deploy and error columns show no data until it is", at: ms(live.generated), open: "view:deploys" });
  }
  const blocked = live.jobs.filter((j) => j.status === "blocked");
  if (blocked.length) {
    out.push({
      sev: "warn",
      kind: "Queue",
      title: `${blocked.length} ${blocked.length === 1 ? "job is" : "jobs are"} waiting on you`,
      sub: [...new Set(blocked.map((j) => j.namespace))].join(", "),
      at: Math.max(...blocked.map((j) => ms(j.updated_at))),
      open: blocked.length === 1 && blocked[0] ? `job:${blocked[0].id}` : "view:queue",
    });
  }
  for (const j of live.jobs) {
    if (j.status === "claimed" && j.lease_expires && ms(j.lease_expires) < now) {
      out.push({ sev: "warn", kind: "Queue", title: `Lease expired: ${j.title}`, sub: `${j.claimed_by ?? "no holder"} · expired ${ago(ms(j.lease_expires), now)}`, at: ms(j.lease_expires), open: `job:${j.id}` });
    }
  }
  for (const a of live.awaiting_seat) {
    out.push({ sev: "warn", kind: "PR", title: `${a.repo} #${a.number} awaits the seat`, sub: `${a.failed}: ${a.why}`, at: ms(a.at), open: "view:ci" });
  }
  if (live.loop.budget.exceeded) {
    out.push({ sev: "warn", kind: "Budget", title: `The ${live.loop.budget.month} budget is exceeded`, sub: `${live.loop.budget.spend.ci_minutes} of ${live.loop.budget.caps.actions_minutes_month} min · $${live.loop.budget.spend.cost_usd.toFixed(2)} of $${live.loop.budget.caps.model_usd_month}`, at: ms(live.generated), open: "view:agents" });
  }
  for (const a of live.agents) {
    if (a.kind === "driver" && !a.revoked_at && a.last_seen && now - ms(a.last_seen) > 7 * DAY) {
      out.push({ sev: "nodata", kind: "Agent", title: `${a.name} has been silent for ${Math.floor((now - ms(a.last_seen)) / DAY)} days`, sub: `last seen ${ago(ms(a.last_seen), now)}`, at: ms(a.last_seen), open: `agent:${a.name}` });
    }
  }
  const rank: Record<Sev, number> = { crit: 0, warn: 1, nodata: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev] || b.at - a.at);
}

// ---- incidents ------------------------------------------------------------------

export interface Incident {
  sev: "crit" | "warn";
  open: boolean;
  title: string;
  fp: string;
  ns: string;
  at: number;
  ref: OpenRef | null;
  status: string;
}

const HOT = /^(probe|down|mirror|backup)/;

export function incidents(feed: OpsFeed): Incident[] {
  const items: Incident[] = [];
  const seen = new Set<string>();
  for (const j of feed.live.jobs) {
    if (!j.finding) continue;
    seen.add(j.finding.fingerprint);
    items.push({
      sev: HOT.test(j.finding.fingerprint) ? "crit" : "warn",
      open: isOpen(j),
      title: j.title.replace(/^Watcher: /, "").replace(/ \[[^\]]*\]$/, ""),
      fp: j.finding.fingerprint,
      ns: j.namespace,
      at: ms(j.created_at),
      ref: `job:${j.id}`,
      status: JOB[j.status].label.toLowerCase(),
    });
  }
  // A check's finding with no job in the live window: shown, not openable.
  for (const c of feed.snapshot?.checks ?? []) {
    if (c.state !== "finding") continue;
    for (const fp of c.findings) {
      if (seen.has(fp)) continue;
      items.push({ sev: HOT.test(fp) ? "crit" : "warn", open: true, title: `Check '${c.id}' reports a finding`, fp, ns: "watcher", at: ms(feed.snapshot?.pass_at ?? feed.live.generated), ref: null, status: "no job in the live window" });
    }
  }
  return items.sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at);
}

// ---- counts ---------------------------------------------------------------------

export function counts(feed: OpsFeed) {
  const sites = feed.snapshot?.sites ?? [];
  const jobs = feed.live.jobs;
  return {
    down: sites.filter((s) => s.state === "down").length,
    degraded: sites.filter((s) => s.state === "degraded").length,
    blocked: jobs.filter((j) => j.status === "blocked").length,
    running: jobs.filter((j) => j.status === "claimed").length,
    queued: jobs.filter((j) => j.status === "queued").length,
    findings: jobs.filter((j) => j.finding && isOpen(j)).length,
    ciRed: (feed.snapshot?.ci ?? []).filter((c) => ciState(c).red).length,
    paused: feed.live.namespaces.filter((n) => n.paused != null).length,
  };
}

// ---- agents -------------------------------------------------------------------------

export function agentState(a: OpsAgent, now: number): { kind: Kind; label: string } {
  if (a.revoked_at) return { kind: "crit", label: "Revoked" };
  if (!a.last_seen) return { kind: "nodata", label: "Never seen" };
  const d = now - ms(a.last_seen);
  if (d < HOUR) return { kind: "ok", label: "Active" };
  if (d < 2 * DAY) return { kind: "queued", label: "Idle" };
  return { kind: "nodata", label: "Silent" };
}

export function nsList(a: OpsAgent): string {
  return a.namespaces === "*" ? "*" : a.namespaces.join(", ");
}

// A namespace's driver is the agent named <ns>-driver.
export function driverOf(feed: OpsFeed, ns: string): OpsAgent | null {
  return feed.live.agents.find((a) => a.name === `${ns}-driver`) ?? null;
}

// The improve loop's attempts for a driver. Null is not a driver, shown as a dash, never zero.
export function attemptsText(a: OpsAgent): string {
  return a.attempts_kept == null || a.attempts_reverted == null ? "-" : `${a.attempts_kept} kept / ${a.attempts_reverted} reverted`;
}

// ---- improve loop mode -------------------------------------------------------------

export const LOOP_MODES = ["api", "subscription", "off"] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

export function loopMode(mode: string): { kind: Kind; label: string } {
  if (mode === "api") return { kind: "ok", label: "API" };
  if (mode === "subscription") return { kind: "ok", label: "Subscription" };
  if (mode === "off") return { kind: "nodata", label: "Off" };
  return { kind: "warn", label: `Unknown mode: ${mode}` };
}
