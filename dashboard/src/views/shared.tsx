import { useCallback, useRef, useState, type ReactNode } from "react";
import type { OpsJob, SiteSnapshot } from "../types";
import { useApp } from "../app/ctx";
import { JOB, PROBE, cfNoData, cfOk, hasSites, incidents, siteKey } from "../lib/derive";
import { age, ago, fmtN, hostOf, ms, pct, shortId } from "../lib/format";
import { Icon, NoData, Pill, St } from "../ui/icons";
import { Spark, Timeline, TimelineLegend, UptimeFoot, UptimeTicks, errorTotals } from "../ui/charts";

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pagehead">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

export function Panel({ title, src, children, className, count }: { title: string; src?: ReactNode; children: ReactNode; className?: string; count?: number }) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      <header>
        <h2>{title}</h2>
        {count != null && <span className="mono faint">{count}</span>}
        {src != null && <span className="src">{src}</span>}
      </header>
      {children}
    </section>
  );
}

export function NsChips({ list }: { list: string[] }) {
  const { filters, setFilters } = useApp();
  const all = ["all", ...new Set(list)];
  return (
    <div className="toolbar" role="group" aria-label="Filter by namespace">
      {all.map((ns) => (
        <button key={ns} type="button" className="chip" aria-pressed={filters.ns === ns} onClick={() => setFilters({ ns })}>
          {ns === "all" ? "All" : ns}
        </button>
      ))}
    </div>
  );
}

export function NoSnapshot() {
  return (
    <div className="callout">
      <St kind="nodata">No data</St> The watcher has not written its first pass yet. Sites, deploys, errors, backups and CI appear after it does.
    </div>
  );
}

// ---- fleet table -------------------------------------------------------------------------

export function LiveDeployCell({ s }: { s: SiteSnapshot }) {
  const { now } = useApp();
  const cf = cfOk(s);
  if (!cf) return <NoData reason={cfNoData(s.cloudflare) ?? ""} />;
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
  if (!cf) return <NoData reason={cfNoData(s.cloudflare) ?? ""} />;
  if (!cf.errors24) return <NoData reason={cf.errors_reason ?? "the analytics read failed"} />;
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
// health contract says so, and that is shown as no data, never as "none" or a zero.
const BACKUP_LIMIT_HOURS = 26;

export function BackupCell({ s }: { s: SiteSnapshot }) {
  const { feed } = useApp();
  const backup = s.namespace === "capsid" ? feed.snapshot?.health?.backup : undefined;
  if (!backup) return <NoData reason="not reported by the site" />;
  if (backup.age_hours == null) return <St kind="crit">Never</St>;
  const over = backup.age_hours > BACKUP_LIMIT_HOURS;
  const width = Math.min(100, (backup.age_hours / BACKUP_LIMIT_HOURS) * 100);
  return (
    <>
      <span className={over ? "mono hot" : "mono"}>{backup.age_hours.toFixed(1)}h</span> <span className="faint mono">/ {BACKUP_LIMIT_HOURS}h</span>
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
            <th>Backup age</th>
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
                  <span className="mono">{s.http_status == null ? "no answer" : `HTTP ${s.http_status}`}</span>
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

const GROUPS: Array<{ key: OpsJob["status"][]; label: string; compact: boolean }> = [
  { key: ["blocked"], label: "Blocked, waiting on you", compact: true },
  { key: ["claimed"], label: "Running", compact: true },
  { key: ["queued"], label: "Queued", compact: true },
  { key: ["done"], label: "Done in the last 24h", compact: false },
  { key: ["failed", "superseded"], label: "Failed or superseded, last 24h", compact: false },
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

export function QueueRows({ jobs, compact }: { jobs: OpsJob[]; compact?: boolean }) {
  const { now, feed } = useApp();
  return (
    <>
      {GROUPS.filter((g) => !compact || g.compact).map((g) => {
        const list = jobs.filter((j) => g.key.includes(j.status)).sort((a, b) => (g.key[0] === "queued" ? b.priority - a.priority : 0) || ms(a.updated_at) - ms(b.updated_at));
        return (
          <div className="qgroup" key={g.label}>
            <h3>
              {g.label} <span className="mono faint">{list.length}</span>
            </h3>
            {list.length ? (
              list.map((j) => {
                const pr = feed.live.prs.find((p) => p.job_id === j.id);
                const sub =
                  j.status === "blocked"
                    ? `Waits on: ${j.waits_on ?? "no reason recorded"}`
                    : j.status === "claimed"
                      ? `Held by ${j.claimed_by ?? "no holder"}`
                      : j.status === "queued"
                        ? `${j.finding ? "Watcher finding · " : ""}${j.id}`
                        : `${pr ? `PR ${pr.pr_url.split("/").slice(-1)[0]} · ` : ""}${j.claimed_by ?? j.id}`;
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
        );
      })}
    </>
  );
}

// ---- incidents -----------------------------------------------------------------------------

export function IncidentFeed({ limit, ns }: { limit?: number; ns?: string }) {
  const { feed, now } = useApp();
  let items = incidents(feed);
  if (ns && ns !== "all") items = items.filter((x) => x.ns === ns);
  if (limit) items = items.slice(0, limit);
  if (!items.length) return <div className="allclear">No watcher findings in the live window.</div>;
  return (
    <div className="feed">
      {items.map((it) => {
        const kind = it.open ? it.sev : "ok";
        return (
          <div className="frow" key={`${it.fp}-${it.ref ?? ""}`} data-row="" data-open={it.ref ?? undefined} tabIndex={it.ref ? 0 : undefined}>
            <Icon kind={kind} style={{ color: `var(--${kind})`, marginTop: 2 }} />
            <div>
              <b>{it.title}</b>
              <div className="sub">
                <span className="ns">{it.ns}</span> · {it.open ? "open" : "closed"}, {it.status} · <span className="mono">{it.fp}</span>
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

export function TimelinePanel({ title, days, src }: { title: string; days: number; src: string }) {
  const { feed, now } = useApp();
  const [width, ref] = useWidth();
  const sites = hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  return (
    <Panel title={title} src={src} className="tl">
      {!hasSites(feed) ? (
        <div className="body faint">No site is configured, so there is no probe to chart. Add one in Settings.</div>
      ) : sites.length ? (
        <>
          <div className="scroll-x tl-pad" ref={ref}>
            <Timeline sites={sites} days={days} now={now} width={width} />
          </div>
          <TimelineLegend />
        </>
      ) : (
        <div className="body">
          <NoSnapshot />
        </div>
      )}
    </Panel>
  );
}

