import type {
  CiObservation,
  OpsAgent,
  OpsFeed,
  OpsJob,
  OpsSnapshot,
  OpsTaskRun,
  ProbeState,
  SiteCloudflare,
  SiteSnapshot,
} from "../types";
import { DAY, HOUR, SLOT_MS, age, ago, hostOf } from "./format";
import { parse } from "capsomer/behavior/time";
import { storeAttention } from "./store";

// The status vocabulary: every state is a shape, a word and a color.
export type Kind =
  | "ok"
  | "warn"
  | "crit"
  | "nodata"
  | "unknown"
  | "run"
  | "queued"
  | "blocked"
  | "done";

export const PROBE: Record<ProbeState, { kind: Kind; label: string }> = {
  ok: { kind: "ok", label: "Up" },
  degraded: { kind: "warn", label: "Degraded" },
  liveness: { kind: "nodata", label: "Liveness only" },
  down: { kind: "crit", label: "Down" },
};

// Site monitoring is optional (capsid/decisions.md, 2026-09-29): with no configured row
// that has an origin, the Portal shows no Sites view and no site items anywhere else.
// Read from the configuration, not the snapshot, so a stale pass cannot bring them back.
export function hasSites(feed: OpsFeed): boolean {
  return feed.live.sites.some((s) => s.origin !== null);
}

// A site is named by its namespace: one ops_sites row each, and its page is /sites/<namespace>.
export function siteKey(s: SiteSnapshot): string {
  return s.namespace;
}

// Why a site has no Cloudflare numbers. Every state but "ok" is no data, never zero.
export function cfNoData(cf: SiteCloudflare | undefined): string | null {
  if (!cf) return "Not read on this pass (the snapshot predates the Cloudflare read)";
  if (cf.state === "ok") return null;
  if (cf.state === "no-token") return "Cloudflare read not configured";
  return cf.reason;
}

// The same, in a few words for a table cell; the full sentence is in the site's panel
// (design D18).
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

/** The Worker scripts the sites run: each settings row's script, or the one the watcher found
 *  from the account's custom domains. One site's when a namespace is named. */
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

// ---- probe ring -------------------------------------------------------------

export const RING_SLOTS = 336;

// Start time of slot i (0 oldest) of the ring padded to RING_SLOTS (capsomer padRing).
export function slotStart(s: SiteSnapshot, i: number): number {
  return (s.ring_slot - (RING_SLOTS - 1 - i)) * SLOT_MS;
}

// ---- jobs -------------------------------------------------------------------

export const JOB: Record<OpsJob["status"], { kind: Kind; label: string }> = {
  queued: { kind: "queued", label: "Queued" },
  claimed: { kind: "run", label: "Running" },
  blocked: { kind: "blocked", label: "Blocked" },
  done: { kind: "done", label: "Done" },
  failed: { kind: "crit", label: "Failed" },
  superseded: { kind: "nodata", label: "Superseded" },
  parked: { kind: "nodata", label: "Parked" },
};

// A claim never expires, so a claimed job nobody has touched for the Worker's stale
// window (src/stale-jobs.ts, 3 days) is shown as Stalled rather than Running.
export const STALE_CLAIM_MS = 3 * DAY;
export function jobBadge(j: OpsJob, now: number): { kind: Kind; label: string } {
  if (j.status === "claimed" && now - parse(j.updated_at) > STALE_CLAIM_MS)
    return { kind: "warn", label: "Stalled" };
  return JOB[j.status];
}

const OPEN_STATUSES: ReadonlyArray<OpsJob["status"]> = ["queued", "claimed", "blocked"];

function isOpen(j: OpsJob): boolean {
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
  if (QUIET.has(l.conclusion))
    return { kind: "ok", label: l.conclusion === "success" ? "Green" : l.conclusion, red: false };
  return { kind: "crit", label: l.conclusion.replace(/_/g, " "), red: true };
}

// ---- watcher staleness --------------------------------------------------------

// A run's outcome in the run ledger (src/task-runs.ts), as the Portal shows it.
export const TASK_OUTCOME: Record<OpsTaskRun["outcome"], { kind: Kind; label: string }> = {
  ok: { kind: "ok", label: "Ok" },
  skipped: { kind: "nodata", label: "Skipped" },
  refused: { kind: "warn", label: "Refused" },
  threw: { kind: "crit", label: "Threw" },
};

export function passStale(snap: OpsSnapshot | null, now: number): boolean {
  return !snap || now - parse(snap.pass_at) > 2 * snap.cadence_min * 60_000;
}

// ---- needs attention ----------------------------------------------------------

type Sev = "crit" | "warn" | "nodata";
type OpenRef = string; // "site:<key>" | "job:<id>" | "agent:<name>" | "view:<id>"

export interface Attention {
  sev: Sev;
  kind: string;
  title: string;
  sub: string;
  at: number;
  open: OpenRef;
  // Rows with the same key are one kind with one cause, and fold into one row on the
  // Overview (attentionGroups). The facet is what tells them apart: a repo, an agent.
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
  // The run ledger (src/task-runs.ts): a scheduled task whose newest run threw or was
  // refused, or a periodic one with no run in twice its period. A failing or quiet
  // backup is critical, as a stale backup is above. A task with no run yet is shown on
  // Incidents only: after the ledger's first deploy every task starts there.
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
  const blocked = live.jobs.filter((j) => j.status === "blocked");
  if (blocked.length) {
    out.push({
      sev: "warn",
      kind: "Queue",
      title: `${blocked.length} ${blocked.length === 1 ? "job is" : "jobs are"} waiting on you`,
      sub: [...new Set(blocked.map((j) => j.namespace))].join(", "),
      at: Math.max(...blocked.map((j) => parse(j.updated_at))),
      open: blocked.length === 1 && blocked[0] ? `job:${blocked[0].id}` : "view:queue",
      group: { key: "blocked", facet: "" },
    });
  }
  // The watcher's attention-class findings (src/watcher.ts, findingClass), which post no
  // job: an agent acting out of its usual pattern (src/anomaly.ts, OWASP item 6; Dustin
  // ruled a hit is a finding plus an attention item and nothing more, D4, 2026-10-03), and
  // open queue breakers. Warnings, never critical.
  for (const f of live.findings) {
    if (f.class !== "attention") continue;
    const agent = f.fingerprint.startsWith("anomaly-");
    out.push({
      sev: "warn",
      kind: agent ? "Agent" : "Breaker",
      title: f.headline,
      sub: agent
        ? "Out of its usual pattern · a finding only, nothing suspended"
        : (f.evidence[0] ?? "Paused after repeated failures"),
      at: parse(f.last_seen),
      open: agent ? "view:health#problems" : "view:needs#waiting",
    });
  }
  for (const a of live.awaiting_seat) {
    out.push({
      sev: "warn",
      kind: "PR",
      title: `${a.repo} #${a.number} awaits the seat`,
      sub: `${a.failed}: ${a.why}`,
      at: parse(a.at),
      open: "view:prs",
      group: { key: "pr-seat", facet: a.repo },
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

// ---- needs attention, grouped (audit ruling 3) ---------------------------------------
//
// Two tiers. A problem (critical or warning) needs a person; a notice (missing data, a
// check that could not run, CI that could not be read, site map drift, a silent
// driver) is a fact with nothing to do now. Session incidents join as problems when
// attentionItems lists them: a failure is critical, a session waiting on input a
// warning. The tier follows from the severity, so any new row lands in the right one.

type Tier = "problem" | "notice";
type GroupKey = "blocked" | "pr-seat" | "silent";

function tierOf(a: { sev: Sev }): Tier {
  return a.sev === "nodata" ? "notice" : "problem";
}

// A group shows up to this many children, then a link to the full view.
export const GROUP_CHILDREN = 5;
// Past this many problem rows the rest of the warnings wait behind "N more warnings".
// Critical rows are always shown.
export const PROBLEM_ROWS = 8;

const GROUPS: Record<GroupKey, { title: (n: number) => string; view: string; label: string }> = {
  // The blocked row is already one row (attentionItems); the group gives it children.
  blocked: {
    title: (n) => `${n} ${n === 1 ? "job is" : "jobs are"} waiting on you`,
    view: "queue",
    label: "Jobs",
  },
  "pr-seat": {
    title: (n) => `${n} pull requests await the seat`,
    view: "prs",
    label: "Pull requests",
  },
  silent: {
    title: (n) => `${n} drivers have been silent for over 7 days`,
    view: "agents",
    label: "Agents",
  },
};

export interface AttentionRow extends Attention {
  key: string;
  // A group: its first children, how many it holds, and the view that lists them all.
  children?: Attention[];
  total?: number;
  view?: { id: string; label: string };
}

export interface AttentionGroups {
  // Worst first: critical, then warnings, newest first within each.
  problems: AttentionRow[];
  notices: AttentionRow[];
  // How many notice items the notice rows stand for (a group counts each of its items).
  noticeCount: number;
}

function fold(items: Attention[], feed: OpsFeed, now: number): AttentionRow[] {
  const out: AttentionRow[] = [];
  const byKey = new Map<GroupKey, Attention[]>();
  for (const a of items) {
    // A critical row is never folded into a collapsed group.
    if (a.group && a.sev !== "crit") {
      const list = byKey.get(a.group.key) ?? [];
      list.push(a);
      byKey.set(a.group.key, list);
    } else out.push({ ...a, key: `${a.kind}|${a.title}` });
  }
  for (const [key, list] of byKey) {
    const g = GROUPS[key];
    const first = list[0]!;
    if (key === "blocked") {
      const jobs = blockedOrder(feed.live.jobs, now).all;
      // One blocked job opens that job; more open in place.
      if (jobs.length < 2) {
        out.push({ ...first, key: "group:blocked" });
        continue;
      }
      out.push({
        ...first,
        title: g.title(jobs.length),
        key: "group:blocked",
        children: jobs.slice(0, GROUP_CHILDREN).map((j) => ({
          sev: "warn",
          kind: "Queue",
          title: j.title,
          sub: `${j.namespace} · waits on: ${j.waits_on ?? "no reason recorded"}`,
          at: parse(j.updated_at),
          open: `job:${j.id}`,
        })),
        total: jobs.length,
        view: { id: g.view, label: g.label },
      });
      continue;
    }
    if (list.length < 2) {
      out.push({ ...first, key: `${first.kind}|${first.title}` });
      continue;
    }
    const sorted = [...list].sort(worstFirst);
    const facets = [...new Set(sorted.map((a) => a.group!.facet))];
    out.push({
      sev: sorted[0]!.sev,
      kind: first.kind,
      title: g.title(list.length),
      sub:
        facets.length > 3
          ? `${facets.slice(0, 3).join(", ")} and ${facets.length - 3} more`
          : facets.join(", "),
      at: Math.max(...list.map((a) => a.at)),
      open: `view:${g.view}`,
      group: first.group,
      key: `group:${key}`,
      children: sorted.slice(0, GROUP_CHILDREN),
      total: list.length,
      view: { id: g.view, label: g.label },
    });
  }
  return out.sort(worstFirst);
}

// What waits on a person's decision: blocked jobs, pull
// requests waiting for you and stopped queues. Needs you lists each of these with its
// buttons, so its Problems list, and Health's, leave them out (UX audit m2: one count, in
// one place).
export const WAITING_KINDS: ReadonlySet<string> = new Set(["Queue", "PR", "Breaker"]);

export function attentionGroups(
  feed: OpsFeed,
  now: number,
  skip?: ReadonlySet<string>,
): AttentionGroups {
  const items = attentionItems(feed, now).filter((a) => !skip?.has(a.kind));
  const notices = items.filter((a) => tierOf(a) === "notice");
  return {
    problems: fold(
      items.filter((a) => tierOf(a) === "problem"),
      feed,
      now,
    ),
    notices: fold(notices, feed, now),
    noticeCount: notices.length,
  };
}

// ---- blocked jobs (audit ruling 10) ---------------------------------------------------
//
// Priority first (high first), then the newest update first. A job blocked for more than
// 7 days goes after the rest. all is the two in that order.

export const STALE_BLOCKED_MS = 7 * DAY;

export function blockedOrder(
  jobs: OpsJob[],
  now: number,
): { blocked: OpsJob[]; stale: OpsJob[]; all: OpsJob[] } {
  const list = jobs
    .filter((j) => j.status === "blocked")
    .sort((a, b) => b.priority - a.priority || parse(b.updated_at) - parse(a.updated_at));
  const blocked = list.filter((j) => now - parse(j.updated_at) <= STALE_BLOCKED_MS);
  const stale = list.filter((j) => now - parse(j.updated_at) > STALE_BLOCKED_MS);
  return { blocked, stale, all: [...blocked, ...stale] };
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

const HOT = /^(probe|down|offaccount|backup)/;

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
      at: parse(j.created_at),
      ref: `job:${j.id}`,
      status: JOB[j.status].label.toLowerCase(),
    });
  }
  // A check's finding with no job in the live window: shown, not openable.
  for (const c of feed.snapshot?.checks ?? []) {
    if (c.state !== "finding") continue;
    for (const fp of c.findings) {
      if (seen.has(fp)) continue;
      items.push({
        sev: HOT.test(fp) ? "crit" : "warn",
        open: true,
        title: `Check '${c.id}' reports a finding`,
        fp,
        ns: "watcher",
        at: parse(feed.snapshot?.pass_at ?? feed.live.generated),
        ref: null,
        status: "no job in the live window",
      });
    }
  }
  return items.sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at);
}

// ---- counts ---------------------------------------------------------------------

export function counts(feed: OpsFeed) {
  const sites = hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  const jobs = feed.live.jobs;
  return {
    down: sites.filter((s) => s.state === "down").length,
    degraded: sites.filter((s) => s.state === "degraded").length,
    blocked: jobs.filter((j) => j.status === "blocked").length,
    running: jobs.filter((j) => j.status === "claimed").length,
    queued: jobs.filter((j) => j.status === "queued").length,
    findings: jobs.filter((j) => j.finding && isOpen(j)).length,
    ciRed: (feed.snapshot?.ci ?? []).filter((c) => ciState(c).red).length,
  };
}

// ---- agents -------------------------------------------------------------------------

// The roster is the live credentials only. A revoked agent leaves it at once, and its row
// leaves the live table 7 days later (docs/auth.md); both are the Archive tab's.
export function rosterAgents(agents: readonly OpsAgent[]): OpsAgent[] {
  return agents.filter((a) => !a.revoked_at && !a.archived_at);
}

/** The Archive tab's rows: revoked and still in the live table, oldest revocation first
 *  (the next to move), then archived, newest move first. */
export function archiveAgents(agents: readonly OpsAgent[]): OpsAgent[] {
  const waiting = agents
    .filter((a) => a.revoked_at && !a.archived_at)
    .sort((x, y) => parse(x.revoked_at as string) - parse(y.revoked_at as string));
  const archived = agents
    .filter((a) => a.archived_at)
    .sort((x, y) => parse(y.archived_at as string) - parse(x.archived_at as string));
  return [...waiting, ...archived];
}

export function agentState(a: OpsAgent, now: number): { kind: Kind; label: string } {
  if (a.archived_at) return { kind: "nodata", label: "Archived" };
  if (a.revoked_at) return { kind: "crit", label: "Revoked" };
  if (!a.last_seen) return { kind: "nodata", label: "Never seen" };
  const d = now - parse(a.last_seen);
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

// The Amazon backup copy at a glance (src/watcher-detect.ts holds the same windows: a
// warning at 30 hours and a job at 36 for a copy, 13 hours for the report, 35 days for the
// restore drill). worst is the oldest of the sites' newest copies.
export const OFFACCOUNT_LATE = 30 * HOUR;
export const OFFACCOUNT_STALE = 36 * HOUR;
export const OFFACCOUNT_REPORT_STALE = 13 * HOUR;
export const OFFACCOUNT_DRILL_STALE = 35 * DAY;

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
  // The latest passing drill; undefined on a snapshot written before the field, which says
  // nothing either way until the next pass.
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
