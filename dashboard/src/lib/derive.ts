import type { AttentionGroupInfo, AttentionItem } from "capsomer/behavior/attention-list";
import { outcomeStatus, type GlyphName, type Tone } from "capsomer/behavior/status";
import type {
  CiObservation,
  OpsFeed,
  OpsSnapshot,
  OpsTaskRun,
  ProbeState,
  SiteCloudflare,
  SiteSnapshot,
} from "../types";
import { DAY, HOUR, SLOT_MS, age, ago, hostOf } from "./format";
import { parse } from "capsomer/behavior/time";
import { storeAttention } from "./store";

export type Kind = "ok" | "warn" | "crit" | "nodata" | "unknown" | "run" | "queued" | "done";

// Draws as Capsomer's Status or Pill (status.md): done ok, run info and running, queued and unknown muted.
export const KIND_STATUS: Record<Kind, { tone: Tone; running?: boolean; glyph?: GlyphName }> = {
  ok: { tone: "ok" },
  warn: { tone: "warn" },
  crit: { tone: "crit" },
  nodata: { tone: "nodata" },
  unknown: { tone: "muted", glyph: "unknown" },
  run: { tone: "info", running: true },
  queued: { tone: "muted", glyph: "queued" },
  done: { tone: "ok" },
};

export const PROBE: Record<ProbeState, { kind: Kind; label: string }> = {
  ok: { kind: "ok", label: "Up" },
  degraded: { kind: "warn", label: "Degraded" },
  liveness: { kind: "nodata", label: "Liveness only" },
  down: { kind: "crit", label: "Down" },
};

// Site monitoring is optional (capsid/decisions.md, 2026-09-29): read from configuration, not the snapshot, so a stale pass cannot bring the Sites view back.
export function hasSites(feed: OpsFeed): boolean {
  return feed.live.sites.some((s) => s.origin !== null);
}

export function siteKey(s: SiteSnapshot): string {
  return s.namespace;
}

// Every state but "ok" is no data, never zero.
export function cfNoData(cf: SiteCloudflare | undefined): string | null {
  if (!cf) return "Not read on this pass (the snapshot predates the Cloudflare read)";
  if (cf.state === "ok") return null;
  if (cf.state === "no-token") return "Cloudflare read not configured";
  return cf.reason;
}

export function cfShort(cf: SiteCloudflare | undefined): string | null {
  if (!cf) return "not read on this pass";
  switch (cf.state) {
    case "ok":
      return null;
    case "no-token":
      return "Cloudflare read not configured";
    case "not-cloudflare":
      return "not on Cloudflare";
    case "unresolved":
      return "Worker not found";
    case "error":
      return "Cloudflare read failed";
  }
}

export function cfOk(s: SiteSnapshot) {
  return s.cloudflare?.state === "ok" ? s.cloudflare : null;
}

export function siteScripts(feed: OpsFeed, ns?: string): string[] {
  const out = new Set<string>();
  for (const r of feed.live.sites)
    if (r.script && (ns === undefined || r.namespace === ns)) out.add(r.script);
  for (const s of feed.snapshot?.sites ?? []) {
    const cf = cfOk(s);
    if (cf && (ns === undefined || s.namespace === ns)) out.add(cf.script);
  }
  return [...out];
}

export const RING_SLOTS = 336;

export function slotStart(s: SiteSnapshot, i: number): number {
  return (s.ring_slot - (RING_SLOTS - 1 - i)) * SLOT_MS;
}

export function ciState(c: CiObservation): { kind: Kind; label: string; red: boolean } {
  const l = c.latest;
  if (!l) return { kind: "nodata", label: "Could not read", red: false };
  if (l.conclusion == null) return { kind: "run", label: l.status.replace(/_/g, " "), red: false };
  // Capsomer's one reading of a conclusion: skipped is no data, canceled and timed out warn; empty reads as still running.
  const o = outcomeStatus(l.conclusion, { success: "Green" });
  if (o.running) return { kind: "run", label: o.label, red: false };
  const kind: Kind = o.tone === "info" || o.tone === "muted" ? "nodata" : o.tone;
  return { kind, label: o.label, red: kind === "crit" };
}

export const TASK_OUTCOME: Record<OpsTaskRun["outcome"], { kind: Kind; label: string }> = {
  ok: { kind: "ok", label: "Ok" },
  skipped: { kind: "nodata", label: "Skipped" },
  refused: { kind: "warn", label: "Refused" },
  threw: { kind: "crit", label: "Threw" },
};

export function passStale(snap: OpsSnapshot | null, now: number): boolean {
  return !snap || now - parse(snap.pass_at) > 2 * snap.cadence_min * 60_000;
}

type Sev = "crit" | "warn" | "nodata";
export type OpenRef = string; // "site:<key>" | "agent:<name>" | "view:<id>"

export interface Attention {
  sev: Sev;
  kind: string;
  title: string;
  sub: string;
  at: number;
  open: OpenRef;
  // Rows with the same key are one kind with one cause and fold into one row (attentionGroups); the facet tells them apart.
  group?: { key: GroupKey; facet: string };
}

export function attentionItems(feed: OpsFeed, now: number): Attention[] {
  const out: Attention[] = [];
  const snap = feed.snapshot;
  const live = feed.live;
  const sitesOn = hasSites(feed);
  if (!snap) {
    // A warning, not a notice: until the first pass nothing about sites or backups is known.
    out.push({
      sev: "warn",
      kind: "Watcher",
      title: "The watcher has not written its first pass yet",
      sub: "Sites, deploys, errors, backups and CI appear after the first pass",
      at: parse(live.generated),
      open: "view:health#problems",
    });
  } else {
    if (passStale(snap, now)) {
      out.push({
        sev: "warn",
        kind: "Watcher",
        title: `The last watcher pass is ${age(parse(snap.pass_at), now)} old`,
        sub: `It runs every ${snap.cadence_min} min; site data is stale after ${2 * snap.cadence_min} min`,
        at: parse(snap.pass_at),
        open: "view:health#problems",
      });
    }
    for (const s of sitesOn ? snap.sites : []) {
      if (s.state === "down" || s.state === "degraded") {
        out.push({
          sev: s.state === "down" ? "crit" : "warn",
          kind: "Site",
          title: `${s.name}: ${s.error ?? PROBE[s.state].label}`,
          sub: `${hostOf(s.origin)} · ${s.http_status == null ? "no answer" : `HTTP ${s.http_status}`} · checked ${ago(parse(s.checked_at), now)}`,
          at: parse(s.checked_at),
          open: `site:${siteKey(s)}`,
        });
      }
      const cf = s.cloudflare;
      if (
        cf &&
        (cf.state === "error" ||
          cf.state === "unresolved" ||
          (cf.state === "no-token" && feed.cloudflare_configured))
      ) {
        out.push({
          sev: "nodata",
          kind: "Site",
          title: `${s.name}: no Cloudflare data`,
          sub: cfNoData(cf) ?? "",
          at: parse(snap.pass_at),
          open: `site:${siteKey(s)}`,
        });
      }
    }
    const h = snap.health;
    if (!h) {
      // A warning, not a notice: an unknown backup is not a quiet fact (audit ruling 3).
      out.push({
        sev: "warn",
        kind: "Backup",
        title: "Capsid health was not read on the last pass",
        sub: "Backup age is unknown",
        at: parse(snap.pass_at),
        open: "view:health#backups",
      });
    } else {
      if (h.status === "degraded")
        out.push({
          sev: "warn",
          kind: "Health",
          title: "Capsid reports degraded health",
          sub: `store d1 ${h.store.d1}, fts ${h.store.fts} · sha ${h.sha.slice(0, 7)}`,
          at: parse(snap.pass_at),
          open: "view:health#backups",
        });
      if (h.backup.warning || !h.backup.last_ok) {
        out.push({
          sev: "crit",
          kind: "Backup",
          title: h.backup.warning ?? "No good backup is recorded",
          sub: h.backup.last_ok
            ? `last good dump ${ago(parse(h.backup.last_ok), now)}`
            : "no last_ok",
          at: h.backup.last_ok ? parse(h.backup.last_ok) : parse(snap.pass_at),
          open: "view:health#backups",
        });
      }
    }
    const o = snap.offaccount;
    if (!o) {
      out.push({
        sev: "warn",
        kind: "Backup",
        title: "The Amazon backup copy's report was not read on the last pass",
        sub: "Each site's newest copy is unknown",
        at: parse(snap.pass_at),
        open: "view:health#backups",
      });
    } else {
      const st = offaccountState(o, now);
      if (st.bad || st.warn) {
        out.push({
          sev: st.bad ? "crit" : "warn",
          kind: "Backup",
          title: st.headline,
          sub: st.detail,
          at: o.reported_at ? parse(o.reported_at) : parse(snap.pass_at),
          open: "view:health#backups",
        });
      }
    }
    for (const c of snap.ci) {
      const st = ciState(c);
      if (!c.latest)
        out.push({
          sev: "nodata",
          kind: "CI",
          title: `CI runs for ${c.namespace} could not be read`,
          sub: "The GitHub read failed on the last pass",
          at: parse(snap.pass_at),
          open: "view:health#ci",
        });
      else if (st.red)
        out.push({
          sev: "warn",
          kind: "CI",
          title: `${c.namespace} default branch is ${st.label}`,
          sub: `${c.latest.head_sha.slice(0, 7)} · ${c.latest.status}`,
          at: parse(c.latest.created_at),
          open: "view:health#ci",
        });
    }
    for (const c of snap.checks) {
      if (c.state === "could-not-run")
        out.push({
          sev: "nodata",
          kind: "Watcher",
          title: `Check '${c.id}' could not run on the last pass`,
          sub: c.findings.join("; "),
          at: parse(snap.pass_at),
          open: "view:health#problems",
        });
    }
    const drift = snap.site_map;
    if (sitesOn && drift && (drift.unmapped.length || drift.unknown.length)) {
      out.push({
        sev: "nodata",
        kind: "Watcher",
        title: `Site map drift: ${drift.unmapped.length} unmapped, ${drift.unknown.length} unknown`,
        sub: [...drift.unmapped, ...drift.unknown].join(", "),
        at: parse(snap.pass_at),
        open: "view:health#problems",
      });
    }
  }
  // The run ledger (src/task-runs.ts): a task whose newest run threw or was refused, or a periodic one with no run in twice its period.
  // Critical like a stale backup. A task with no run yet shows on Incidents only (after the ledger's first deploy every task starts there).
  if (feed.scheduled.error !== null) {
    out.push({
      sev: "nodata",
      kind: "Scheduled",
      title: "The run ledger could not be read",
      sub: feed.scheduled.error,
      at: parse(live.generated),
      open: "view:health#problems",
    });
  } else {
    for (const t of feed.scheduled.tasks) {
      const last = t.recent[0];
      if (!last || (t.flag !== "failing" && t.flag !== "quiet")) continue;
      out.push({
        sev: t.id === "backup" ? "crit" : "warn",
        kind: "Scheduled",
        title:
          t.flag === "failing"
            ? `${t.label}: its last run ${TASK_OUTCOME[last.outcome].label.toLowerCase()}`
            : `${t.label} has not run for ${age(parse(last.finished_at), now)}`,
        sub: last.reason,
        at: parse(last.finished_at),
        open: "view:health#problems",
      });
    }
  }
  if (!feed.cloudflare_configured) {
    out.push({
      sev: "nodata",
      kind: "Watcher",
      title: "Cloudflare read not configured",
      sub: "Deploy and error columns show no data until it is",
      at: parse(live.generated),
      open: "view:sites#deploys",
    });
  }
  const store = storeAttention(feed);
  if (store)
    out.push({
      sev: "warn",
      kind: "Backup",
      ...store,
      at: parse(live.generated),
      open: "view:health#backups",
    });
  // Watcher findings about an agent acting out of pattern (src/anomaly.ts, OWASP item 6; D4, 2026-10-03: a finding plus an attention item, nothing
  // more). Warnings only. Waiting PRs live on Needs you (UX audit m2: one count, one place).
  for (const f of live.findings) {
    if (f.class !== "attention" || !f.fingerprint.startsWith("anomaly-")) continue;
    out.push({
      sev: "warn",
      kind: "Agent",
      title: f.headline,
      sub: "Out of its usual pattern · a finding only, nothing suspended",
      at: parse(f.last_seen),
      open: "view:health#problems",
    });
  }
  for (const a of live.agents) {
    if (a.kind === "driver" && !a.revoked_at && a.last_seen && now - parse(a.last_seen) > 7 * DAY) {
      out.push({
        sev: "nodata",
        kind: "Agent",
        title: `${a.name} has been silent for ${Math.floor((now - parse(a.last_seen)) / DAY)} days`,
        sub: `last seen ${ago(parse(a.last_seen), now)}`,
        at: parse(a.last_seen),
        open: `agent:${a.name}`,
        group: { key: "silent", facet: a.name },
      });
    }
  }
  return out.sort(worstFirst);
}

const RANK: Record<Sev, number> = { crit: 0, warn: 1, nodata: 2 };
function worstFirst(a: { sev: Sev; at: number }, b: { sev: Sev; at: number }): number {
  return RANK[a.sev] - RANK[b.sev] || b.at - a.at;
}

// Two tiers: a problem (critical or warning) needs a person; a notice (missing data, a check that could not run, a silent driver) is a
// fact with nothing to do now. The tier follows from severity (Capsomer's arrange), so a new row lands right and same-cause rows fold.

type GroupKey = "silent";

const GROUPS: Record<GroupKey, { title: (n: number) => string; view: string; label: string }> = {
  silent: {
    title: (n) => `${n} drivers have been silent for over 7 days`,
    view: "agents",
    label: "Agents",
  },
};

// `href` turns a row's OpenRef into the address it opens.
export function attentionList(
  feed: OpsFeed,
  now: number,
  href: (ref: OpenRef) => string,
): { items: AttentionItem[]; groups: Record<string, AttentionGroupInfo> } {
  const rows = attentionItems(feed, now);
  const items = rows.map((a, i): AttentionItem => ({
    id: `${a.kind}|${a.title}|${i}`,
    tone: a.sev,
    title: a.title,
    detail: `${a.kind} · ${a.sub}`,
    when: { text: ago(a.at, now), datetime: new Date(a.at).toISOString() },
    href: href(a.open),
    group: a.group?.key,
  }));
  const groups: Record<string, AttentionGroupInfo> = {};
  for (const [key, g] of Object.entries(GROUPS)) {
    const facets = [
      ...new Set(rows.filter((a) => a.group?.key === key).map((a) => a.group!.facet)),
    ];
    groups[key] = {
      title: g.title,
      detail:
        facets.length > 3
          ? `${facets.slice(0, 3).join(", ")} and ${facets.length - 3} more`
          : facets.join(", "),
      view: { href: href(`view:${g.view}`), label: g.label },
    };
  }
  return { items, groups };
}

// Windows match src/watcher-detect.ts (warning at 30 hours, alert at 36 for a copy; 13 hours report; 35 days restore drill). worst is the oldest of the sites' newest copies.
export const OFFACCOUNT_LATE = 30 * HOUR;
export const OFFACCOUNT_STALE = 36 * HOUR;
const OFFACCOUNT_REPORT_STALE = 13 * HOUR;
const OFFACCOUNT_DRILL_STALE = 35 * DAY;

export function offaccountState(o: NonNullable<OpsSnapshot["offaccount"]>, now: number) {
  const missing = o.sites.filter((s) => !s.newest).map((s) => s.site);
  const ageOf = (s: { newest: string | null }) => (s.newest ? now - parse(s.newest) : null);
  const stale = o.sites.filter((s) => (ageOf(s) ?? 0) >= OFFACCOUNT_STALE).map((s) => s.site);
  const late = o.sites
    .filter((s) => {
      const a = ageOf(s);
      return a != null && a >= OFFACCOUNT_LATE && a < OFFACCOUNT_STALE;
    })
    .map((s) => s.site);
  const ages = o.sites.map(ageOf).filter((a): a is number => a != null);
  const worst = ages.length ? Math.max(...ages) : null;
  const reportAge = o.reported_at ? now - parse(o.reported_at) : null;
  const silent = reportAge == null || reportAge >= OFFACCOUNT_REPORT_STALE;
  // undefined on a snapshot written before the field: says nothing until the next pass.
  const drill = o.last_drill;
  const drillOk =
    drill === undefined || (drill?.at != null && now - parse(drill.at) < OFFACCOUNT_DRILL_STALE);
  const bad = missing.length > 0 || stale.length > 0 || silent || !drillOk;
  const headline =
    reportAge == null
      ? "No report of the Amazon backup copy has arrived"
      : missing.length
        ? `The Amazon backup copy holds nothing for ${missing.join(", ")}`
        : stale.length
          ? `The Amazon backup copy is stale for ${stale.join(", ")}`
          : silent
            ? `The Amazon backup copy has not reported in ${(reportAge / HOUR).toFixed(0)} hours`
            : !drillOk
              ? "No restore drill from Amazon has passed in 35 days"
              : late.length
                ? `The Amazon backup copy is late for ${late.join(", ")}`
                : "The Amazon backup copy is current";
  const detail = o.last_run
    ? `Last copy run ${o.last_run.conclusion ?? "still running"}${o.last_run.at ? ` ${ago(parse(o.last_run.at), now)}` : ""}`
    : "No copy run recorded";
  return {
    missing,
    stale,
    late,
    worst,
    reportAge,
    bad,
    warn: !bad && late.length > 0,
    headline,
    detail,
  };
}
