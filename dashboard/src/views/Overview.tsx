import { Suspense, lazy, type ReactNode } from "react";
import { Link } from "wouter";
import { routePath, useApp, type ViewId } from "../app/ctx";
import { PROBE, cfOk, cfShort, counts, hasSites, isOpen, ringOf, siteKey, uptime } from "../lib/derive";
import { DAY, age, ago, fmtN, hostOf, ms, pct, shortId } from "../lib/format";
import type { SiteSnapshot } from "../types";
import { Anchors } from "../ui/anchors";
import { UptimeTicks, errorTotals } from "../ui/charts";
import { NoData, St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
import { NoSnapshot, PageHead, TimelinePanel } from "./shared";

// The Overview is the glance at the system: six summary tiles, the daily maintenance
// pass's list (job_549550d73d4e), one row per site, and the week of deploys. What needs
// Dustin moved to the Needs you page, the home (docs/design/design-portal-evaluation.md,
// DECIDE 1, ruled 2026-10-09). Site monitoring is optional: with no site configured there
// is no site tile, no Sites table and no timeline.

interface Tile {
  label: string;
  v: ReactNode;
  d: string;
  cls: "" | "ok" | "warn" | "crit";
  go: ViewId;
}

// The Maintenance list loads on its own, after the Overview's first paint.
const Maintenance = lazy(() => import("./Maintenance").then((m) => ({ default: m.Maintenance })));

// Past this many sites the table shows the ones not up, then the rest up to the limit.
const SITE_ROWS = 10;

export function Overview() {
  const { feed, now } = useApp();
  const c = counts(feed);
  const snap = feed.snapshot;
  const live = feed.live;
  const blocked = live.jobs.filter((j) => j.status === "blocked");
  const budget = live.loop.budget;
  const minutesFrac = budget.caps.actions_minutes_month ? budget.spend.ci_minutes / budget.caps.actions_minutes_month : 0;
  const backup = snap?.health?.backup ?? null;
  const mirrorAge = snap?.mirror?.newest_dump ? now - ms(snap.mirror.newest_dump) : null;
  const findingsOpen = c.findings;
  const sitesOn = hasSites(feed);
  const siteTile: Tile | null = !sitesOn
    ? null
    : snap
      ? { label: "Sites up", v: <>{snap.sites.length - c.down - c.degraded}<small>/{snap.sites.length}</small></>, d: `${c.down} down · ${c.degraded} degraded`, cls: c.down ? "crit" : c.degraded ? "warn" : "ok", go: "sites" }
      : { label: "Sites up", v: <small>No data</small>, d: "no watcher pass yet", cls: "", go: "sites" };
  const tiles: Tile[] = [
    ...(siteTile ? [siteTile] : []),
    { label: "Blocked on you", v: String(c.blocked), d: blocked.length ? `oldest ${age(Math.min(...blocked.map((j) => ms(j.updated_at))), now)}` : "nothing waiting", cls: c.blocked ? "warn" : "ok", go: "queue" },
    { label: "Running", v: String(c.running), d: `${c.queued} queued · across ${new Set(live.jobs.filter(isOpen).map((j) => j.namespace)).size} namespaces`, cls: "", go: "queue" },
    backup && backup.age_hours != null
      ? { label: "Primary backup", v: <>{backup.age_hours.toFixed(1)}<small>h</small></>, d: mirrorAge == null ? "mirror: no data" : `mirror ${Math.floor(mirrorAge / DAY)}d old`, cls: backup.warning || (mirrorAge != null && mirrorAge > 2 * DAY) ? "crit" : "ok", go: "backups" }
      : { label: "Primary backup", v: <small>No data</small>, d: snap?.health ? "no good dump recorded" : "health not read", cls: snap?.health ? "crit" : "", go: "backups" },
    { label: "Open findings", v: String(findingsOpen), d: snap ? `watcher pass ${ago(ms(snap.pass_at), now)}` : "no watcher pass yet", cls: findingsOpen ? "warn" : "ok", go: "incidents" },
    { label: "Actions budget", v: <>{budget.spend.ci_minutes}<small>/{budget.caps.actions_minutes_month} min</small></>, d: `$${budget.spend.cost_usd.toFixed(2)} of $${budget.caps.model_usd_month} · loop ${live.loop.mode}`, cls: budget.exceeded ? "crit" : minutesFrac > 0.8 ? "warn" : "", go: "agents" },
  ];
  return (
    <div className="page">
      <Anchors />
      <PageHead title="Overview" />
      {/* Figure and label on one line, the detail under them; a tile is never narrower
          than its text, so the row wraps instead of cutting a word (design D3). */}
      <div className="tiles" id="summary" data-section="Summary">
        {tiles.map((t) => (
          <Link key={t.label} href={routePath(t.go)} className={`tile ${t.cls}`}>
            <span className="t1">
              <span className="v">{t.v}</span>
              <span className="l">{t.label}</span>
            </span>
            <span className="d">{t.d}</span>
          </Link>
        ))}
      </div>
      <Suspense fallback={null}>
        <Maintenance />
      </Suspense>
      {sitesOn && (
        <>
          <Panel
            flush
            title="Sites"
            id="sites"
            section="Sites"
            count={snap?.sites.length}
            src={snap ? `watcher pass ${ago(ms(snap.pass_at), now)}` : undefined}
            more={
              <Link href={routePath("sites")}>
                All columns in Sites
              </Link>
            }
          >
            {snap ? <SitesTable sites={snap.sites} /> : <NoSnapshot />}
          </Panel>
          <TimelinePanel title="Deploys and downtime, 7 days" days={7} src="Cloudflare deployments · probe ring" id="deploys" section="Deploys" />
        </>
      )}
    </div>
  );
}

// ---- Sites ------------------------------------------------------------------------------

// One 34 px row per site, five columns. Backup age and the probe detail are in the Sites
// view and the site's panel; a cell with no data says two words, its reason on hover and
// in full in the panel (design D18).
function SitesTable({ sites }: { sites: SiteSnapshot[] }) {
  const { now } = useApp();
  const notUp = sites.filter((s) => s.state === "down" || s.state === "degraded");
  const list = sites.length > SITE_ROWS ? [...notUp, ...sites.filter((s) => !notUp.includes(s)).slice(0, Math.max(0, SITE_ROWS - notUp.length))] : sites;
  return (
    <div className="sites-brief">
      <table className="brief">
        <thead>
          <tr>
            <th>Site</th>
            <th>Status</th>
            <th className="c-up">Uptime, 7 days</th>
            <th className="c-deploy">Live deploy</th>
            <th className="c-err">Errors, 24h</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => {
            const p = PROBE[s.state];
            const up = uptime(ringOf(s));
            const cf = cfOk(s);
            const d = cf?.deploys[0];
            const t = cf?.errors24 ? errorTotals(cf.errors24) : null;
            return (
              <tr key={siteKey(s)} data-row="" data-open={`site:${siteKey(s)}`} tabIndex={0}>
                <td className="site">
                  <b>{s.name}</b>
                  <span className="host">{hostOf(s.origin)}</span>
                </td>
                <td>
                  <St kind={p.kind}>{p.label}</St>
                </td>
                <td className="c-up">
                  <div className="upline">
                    <UptimeTicks site={s} />
                    {up == null ? <NoData brief reason="no probe in 7 days" /> : <span className="num">{pct(up)}</span>}
                  </div>
                </td>
                <td className="c-deploy">
                  {!cf ? (
                    <NoData brief reason={cfShort(s.cloudflare) ?? ""} />
                  ) : d ? (
                    <>
                      <span className="mono">{shortId(d.version_id ?? d.id)}</span> <span className="faint">{ago(ms(d.created_on), now)}</span>
                    </>
                  ) : (
                    <span className="faint">None recorded</span>
                  )}
                </td>
                <td className="c-err">
                  {!cf ? (
                    <NoData brief reason={cfShort(s.cloudflare) ?? ""} />
                  ) : !t ? (
                    <NoData brief reason="the analytics read failed" />
                  ) : (
                    <span className={t.rate != null && t.rate > 0.01 ? "num hot" : "num"}>
                      {fmtN(t.err)} of {fmtN(t.req)}
                      {t.rate == null ? "" : ` · ${pct(t.rate)}`}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.length < sites.length && (
        <div className="grouplink">
          <Link href={routePath("sites")}>All {sites.length} sites in Sites</Link>
        </div>
      )}
    </div>
  );
}
