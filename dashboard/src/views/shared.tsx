import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import type { OpsJob, SiteSnapshot } from "../types";
import { useApp } from "../app/ctx";
import { JOB, PROBE, blockedOrder, cfShort, cfOk, hasSites, incidents, siteKey } from "../lib/derive";
import { age, agentLabel, ago, fmtN, hostOf, ms, pct, shortId } from "../lib/format";
import { Icon, NoData, Pill, St } from "../ui/icons";
import { Spark, Timeline, TimelineLegend, UptimeFoot, UptimeTicks, errorTotals } from "../ui/charts";

// The heading only: what a view is for is one line in the shortcut sheet (design D13).
export function PageHead({ title }: { title: string }) {
  return (
    <div className="pagehead">
      <h1>{title}</h1>
    </div>
  );
}

// A view's namespace filter: its own, in the address as ?ns=<namespace>, so picking one
// on Incidents leaves Sites alone, and a filtered view can be reloaded or shared. "all"
// when absent. Other query parameters are kept.
export function useNsFilter(): [string, (ns: string) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const ns = new URLSearchParams(search).get("ns") || "all";
  const set = useCallback(
    (next: string) => {
      const qs = new URLSearchParams(search);
      if (next === "all") qs.delete("ns");
      else qs.set("ns", next);
      const q = qs.toString();
      navigate(q ? `${location}?${q}` : location, { replace: true });
    },
    [search, location, navigate],
  );
  return [ns, set];
}

export function NsChips({ list }: { list: string[] }) {
  const [ns, setNs] = useNsFilter();
  const all = ["all", ...new Set(list)];
  // A namespace from the address that this list does not carry still shows, pressed.
  if (!all.includes(ns)) all.push(ns);
  return (
    <div className="toolbar" role="group" aria-label="Filter by namespace">
      {all.map((n) => (
        <button key={n} type="button" className="chip" aria-pressed={ns === n} onClick={() => setNs(n)}>
          {n === "all" ? "All" : n}
        </button>
      ))}
    </div>
  );
}

// What a filtered list says when the filter leaves it empty: which filter, and a way back
// (pattern catalogue, N-empty).
export function FilterEmpty({ children, onShowAll }: { children: ReactNode; onShowAll: () => void }) {
  return (
    <div role="status" data-filter-empty="">
      <Empty
        kind="no-match"
        title={children}
        action={
          <button type="button" className="btn" onClick={onShowAll}>
            Show all
          </button>
        }
      />
    </div>
  );
}

export function NoSnapshot() {
  return (
    <Empty kind="nothing-yet" title={<St kind="nodata">No data</St>}>
      The watcher has not written its first pass yet. Sites, deploys, errors, backups and CI appear after it does.
    </Empty>
  );
}

// ---- fleet table -------------------------------------------------------------------------

export function LiveDeployCell({ s }: { s: SiteSnapshot }) {
  const { now } = useApp();
  const cf = cfOk(s);
  if (!cf) return <NoData brief reason={cfShort(s.cloudflare) ?? ""} />;
  const d = cf.deploys[0];
  if (!d) return <span className="faint">No deploys recorded</span>;
  return (
    <>
      <span className="mono">{shortId(d.version_id ?? d.id)}</span>
      <div className="src">
        {ago(ms(d.created_on), now)}
        {d.triggered_by ? ` · ${d.triggered_by}` : ""}
      </div>
    </>
  );
}

export function ErrorTotalsCell({ s }: { s: SiteSnapshot }) {
  const cf = cfOk(s);
  if (!cf) return <NoData brief reason={cfShort(s.cloudflare) ?? ""} />;
  if (!cf.errors24) return <NoData brief reason="the analytics read failed" />;
  const t = errorTotals(cf.errors24);
  const hot = t.rate != null && t.rate > 0.01;
  return (
    <>
      <Spark values={cf.errors24.map((x) => x.errors)} color={hot ? "var(--crit)" : "var(--muted)"} label={`Errors per hour for ${s.name}, last 24 hours: ${fmtN(t.err)} of ${fmtN(t.req)} requests`} />
      <div className={`src${hot ? " hot" : ""}`}>
        {fmtN(t.err)} / {fmtN(t.req)} · {pct(t.rate)}
      </div>
    </>
  );
}

// Capsid's own backup is the only one the feed carries (snapshot.health.backup, against
// the 26-hour window /health uses). Every other site's backup is not reported until its
// health contract says so, and that is shown as no data, never as "none" or a zero. The
// column header says so once; each cell says "No data" (design D18).
const BACKUP_LIMIT_HOURS = 26;

export function BackupCell({ s }: { s: SiteSnapshot }) {
  const { feed } = useApp();
  const backup = s.namespace === "capsid" ? feed.snapshot?.health?.backup : undefined;
  if (!backup) return <NoData brief reason="not reported by the site" />;
  if (backup.age_hours == null) return <St kind="crit">Never</St>;
  const over = backup.age_hours > BACKUP_LIMIT_HOURS;
  const width = Math.min(100, (backup.age_hours / BACKUP_LIMIT_HOURS) * 100);
  return (
    <>
      <span className={over ? "num hot" : "num"}>{backup.age_hours.toFixed(1)}h</span> <span className="faint num">/ {BACKUP_LIMIT_HOURS}h</span>
      <div className="backupbar" role="img" aria-label={`Backup age ${backup.age_hours.toFixed(1)} of ${BACKUP_LIMIT_HOURS} hours`}>
        <i className={over ? "crit" : backup.age_hours > BACKUP_LIMIT_HOURS * 0.75 ? "warn" : ""} style={{ width: `${width}%` }} />
      </div>
    </>
  );
}

export function FleetTable({ sites }: { sites: SiteSnapshot[] }) {
  const { now } = useApp();
  return (
    <div className="scroll-x reflow">
      <table className="fleet cards-below-1100">
        <thead>
          <tr>
            <th>Site</th>
            <th>Status</th>
            <th>Uptime, 2-hour ticks</th>
            <th>Live deploy</th>
            <th>Errors 24h</th>
            <th>
              Backup age <span className="th-note">only Capsid reports one</span>
            </th>
            <th>Probe</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => {
            const p = PROBE[s.state];
            return (
              <tr key={siteKey(s)} data-row="" data-open={`site:${siteKey(s)}`} tabIndex={0}>
                <td className="site">
                  <b>{s.name}</b>
                  <span>{hostOf(s.origin)}</span>
                </td>
                <td data-label="Status">
                  <Pill kind={p.kind}>{p.label}</Pill>
                  <div className="src mt4">{s.latency_ms == null ? "no answer" : `${s.latency_ms} ms`}</div>
                </td>
                <td data-label="Uptime, 2-hour ticks" className="w30">
                  <UptimeTicks site={s} />
                  <UptimeFoot site={s} />
                </td>
                <td data-label="Live deploy">
                  <LiveDeployCell s={s} />
                </td>
                <td data-label="Errors 24h">
                  <ErrorTotalsCell s={s} />
                </td>
                <td data-label="Backup age">
                  <BackupCell s={s} />
                </td>
                <td data-label="Probe">
                  <span className="num">{s.http_status == null ? "no answer" : `HTTP ${s.http_status}`}</span>
                  <div className="src">
                    {s.health_path ?? "/"} · {ago(ms(s.checked_at), now)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- queue -------------------------------------------------------------------------------

// The Queue's groups, in order. Blocked jobs are ordered by priority, then the newest
// update first, and a job blocked for over 7 days waits in Stale, after them (audit
// ruling 10, lib/derive.ts blockedOrder). Done and Failed start collapsed: nothing in
// them needs a person.
type QueueGroup = { id: string; label: string; pick: (jobs: OpsJob[], now: number) => OpsJob[]; collapsed?: boolean; hideEmpty?: boolean };

const byStatus = (st: OpsJob["status"][]) => (jobs: OpsJob[]) => jobs.filter((j) => st.includes(j.status)).sort((a, b) => ms(a.updated_at) - ms(b.updated_at));

const GROUPS: QueueGroup[] = [
  { id: "blocked", label: "Blocked, waiting on you", pick: (jobs, now) => blockedOrder(jobs, now).blocked },
  { id: "stale", label: "Stale, blocked over 7 days", pick: (jobs, now) => blockedOrder(jobs, now).stale, hideEmpty: true },
  { id: "running", label: "Running", pick: byStatus(["claimed"]) },
  { id: "queued", label: "Queued", pick: (jobs) => jobs.filter((j) => j.status === "queued").sort((a, b) => b.priority - a.priority || ms(a.updated_at) - ms(b.updated_at)) },
  { id: "done", label: "Done in the last 24h", pick: byStatus(["done"]), collapsed: true },
  { id: "failed", label: "Failed or superseded, last 24h", pick: byStatus(["failed", "superseded"]), collapsed: true },
];

export function jobMeta(j: OpsJob, now: number): string {
  switch (j.status) {
    case "blocked":
      return `waiting ${age(ms(j.updated_at), now)}`;
    case "claimed":
      return j.lease_expires ? `lease ${ago(ms(j.lease_expires), now)}` : "no lease";
    case "queued":
      return `queued ${ago(ms(j.created_at), now)}`;
    default:
      return `${JOB[j.status].label.toLowerCase()} ${ago(ms(j.updated_at), now)}`;
  }
}

export function QueueRows({ jobs }: { jobs: OpsJob[] }) {
  const { now, feed } = useApp();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      {GROUPS.map((g) => {
        const list = g.pick(jobs, now);
        if (g.hideEmpty && !list.length) return null;
        // A collapsed group is a disclosure (APG): a button that says whether it is open.
        const shown = !g.collapsed || open[g.id] === true;
        const bodyId = `qg-${g.id}`;
        return (
          <div className="qgroup" key={g.id} data-group={g.id}>
            <h3>
              {g.collapsed ? (
                <button type="button" className="disclose" aria-expanded={shown} aria-controls={bodyId} onClick={() => setOpen((o) => ({ ...o, [g.id]: !shown }))}>
                  <span className="chev" aria-hidden="true" />
                  {g.label} <span className="num faint">{list.length}</span>
                </button>
              ) : (
                <>
                  {g.label} <span className="num faint">{list.length}</span>
                </>
              )}
            </h3>
            <div id={bodyId} hidden={!shown}>
              {!shown ? null : list.length ? (
                list.map((j) => {
                  const pr = feed.live.prs.find((p) => p.job_id === j.id);
                  // Plain English in the row; the job id is in the drawer (D11).
                  const sub =
                    j.status === "blocked"
                      ? `Waits on: ${j.waits_on ?? "no reason recorded"}`
                      : j.status === "claimed"
                        ? `Held by ${j.claimed_by ? agentLabel(j.claimed_by) : "no holder"}`
                        : j.status === "queued"
                          ? `${j.finding ? "Watcher finding · " : ""}priority ${j.priority}`
                          : `${pr ? `PR #${pr.pr_url.split("/").slice(-1)[0]} · ` : ""}${j.claimed_by ? agentLabel(j.claimed_by) : "no holder"}`;
                  const k = JOB[j.status];
                  return (
                    <div className="qrow" key={j.id} data-row="" data-open={`job:${j.id}`} tabIndex={0}>
                      <St kind={k.kind}>{k.label}</St>
                      <div className="t">
                        <b>{j.title}</b>
                        <div>{sub}</div>
                      </div>
                      <div className="m">
                        <span className="ns">{j.namespace}</span>
                        <br />
                        {jobMeta(j, now)}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="empty-group">None</div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ---- incidents -----------------------------------------------------------------------------

export function IncidentFeed({ ns }: { ns?: string }) {
  const { feed, now } = useApp();
  let items = incidents(feed);
  if (ns && ns !== "all") items = items.filter((x) => x.ns === ns);
  if (!items.length) return <Empty kind="all-clear" title="No watcher findings in the live window." />;
  return (
    <div className="feed">
      {items.map((it) => {
        const kind = it.open ? it.sev : "ok";
        // The fingerprint is raw detail: in the job's drawer when the finding has a job,
        // and on hover when it has none to open (D11).
        return (
          <div
            className={kind === "crit" ? "frow sev-crit" : "frow"}
            key={`${it.fp}-${it.ref ?? ""}`}
            data-row=""
            data-open={it.ref ?? undefined}
            tabIndex={it.ref ? 0 : undefined}
            title={it.ref ? undefined : `fingerprint ${it.fp}`}
          >
            <Icon kind={kind} style={{ color: `var(--${kind})` }} />
            <div className="t">
              <b>{it.title}</b>
              <div className="sub">
                <span className="ns">{it.ns}</span> · {it.open ? "open" : "closed"}, {it.status}
              </div>
            </div>
            <div className="m">
              first seen
              <br />
              {ago(it.at, now)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- timeline panel ------------------------------------------------------------------------

// The content-box width of an element, kept current as the layout changes (the window,
// the rail collapsing).
function useWidth(): [number | null, (el: HTMLElement | null) => void] {
  const [w, setW] = useState<number | null>(null);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setW(e.contentRect.width);
    });
    ro.observe(el);
    obs.current = ro;
  }, []);
  return [w, ref];
}

export function TimelinePanel({ title, days, src, id, section }: { title: string; days: number; src: string; id?: string; section?: string }) {
  const { feed, now } = useApp();
  const [width, ref] = useWidth();
  const sites = hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  // The legend sits in the header beside the source, so the chart is all the body holds.
  return (
    <Panel flush title={title} src={sites.length ? <span className="tl-head"><TimelineLegend /><span>{src}</span></span> : src} className="tl" id={id} section={section}>
      {!hasSites(feed) ? (
        <div className="body faint">No site is configured, so there is no probe to chart. Add one in Settings.</div>
      ) : sites.length ? (
        <>
          <div className="scroll-x tl-pad" ref={ref}>
            <Timeline sites={sites} days={days} now={now} width={width} />
          </div>
        </>
      ) : (
        <NoSnapshot />
      )}
    </Panel>
  );
}

