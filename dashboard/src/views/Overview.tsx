import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { isView, routePath, useApp, type ViewId } from "../app/ctx";
import { PROBE, PROBLEM_ROWS, attentionGroups, cfOk, cfShort, counts, hasSites, isOpen, ringOf, siteKey, uptime, type AttentionRow } from "../lib/derive";
import { DAY, age, ago, fmtN, hostOf, ms, pct, shortId } from "../lib/format";
import type { SiteSnapshot } from "../types";
import { Anchors } from "../ui/anchors";
import { UptimeTicks, errorTotals } from "../ui/charts";
import { Icon, NoData, St } from "../ui/icons";
import { NoSnapshot, PageHead, Panel, TimelinePanel } from "./shared";

// The Overview answers one question: does anything need me? In order: six summary
// tiles, the problems worst first with like rows grouped, the notices collapsed, one
// row per site, and the week of deploys (capsid/research/audit-ui-patterns.md,
// "Proposed Overview", rulings 1 to 3). No Queue and no Incidents panel: their counts
// are tiles and their problems are rows (ruling 2). Site monitoring is optional: with no
// site configured there is no site tile, no Sites table and no timeline.

interface Tile {
  label: string;
  v: ReactNode;
  d: string;
  cls: "" | "ok" | "warn" | "crit";
  go: ViewId;
}

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
      <NeedsAttention sitesOn={sitesOn} />
      {sitesOn && (
        <>
          <Panel
            title="Sites"
            id="sites"
            section="Sites"
            count={snap?.sites.length}
            src={snap ? `watcher pass ${ago(ms(snap.pass_at), now)}` : undefined}
            more={
              <Link className="more" href={routePath("sites")}>
                All columns in Sites
              </Link>
            }
          >
            {snap ? <SitesTable sites={snap.sites} /> : <div className="body"><NoSnapshot /></div>}
          </Panel>
          <TimelinePanel title="Deploys and downtime, 7 days" days={7} src="Cloudflare deployments · probe ring" id="deploys" section="Deploys" />
        </>
      )}
    </div>
  );
}

// ---- Needs attention ----------------------------------------------------------------

function NeedsAttention({ sitesOn }: { sitesOn: boolean }) {
  const { feed, now } = useApp();
  const { problems, notices, noticeCount } = attentionGroups(feed, now);
  const [more, setMore] = useState(false);
  // Every critical row is shown; warnings fill the rest of the first PROBLEM_ROWS.
  const crit = problems.filter((p) => p.sev === "crit");
  const room = Math.max(0, PROBLEM_ROWS - crit.length);
  const warn = problems.filter((p) => p.sev !== "crit");
  const hidden = warn.length > room ? warn.slice(room) : [];
  const shown = [...crit, ...(hidden.length ? warn.slice(0, room) : warn)];
  return (
    <section className="attention" id="attention" data-section="Needs attention" aria-labelledby="attH">
      <header>
        <h2 id="attH">Needs attention</h2>
        <span className="num faint">{problems.length ? `${problems.length} ${problems.length === 1 ? "problem" : "problems"}, worst first` : "no problems"}</span>
        <span className="src ml-auto">{sitesOn ? "sites, " : ""}backups, CI, queue, watcher, agents</span>
      </header>
      {problems.length ? (
        <div className="att-list">
          {shown.map((a) => (a.children ? <GroupRow key={a.key} row={a} /> : <ProblemRow key={a.key} row={a} />))}
          {hidden.length > 0 && (
            <>
              <div className="att-more">
                <button type="button" className="linkbtn" aria-expanded={more} aria-controls="att-more" onClick={() => setMore(!more)}>
                  {more ? "Fewer warnings" : `${hidden.length} more ${hidden.length === 1 ? "warning" : "warnings"}`}
                </button>
              </div>
              <div id="att-more" hidden={!more}>
                {more && hidden.map((a) => (a.children ? <GroupRow key={a.key} row={a} /> : <ProblemRow key={a.key} row={a} />))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="allclear">
          <Icon kind="ok" /> All clear. Nothing needs you.
        </div>
      )}
      {notices.length > 0 && <Notices rows={notices} count={noticeCount} />}
    </section>
  );
}

function ProblemRow({ row }: { row: AttentionRow }) {
  const { now } = useApp();
  return (
    <div className={row.sev === "crit" ? "att-row sev-crit" : "att-row"} data-row="" data-open={row.open} tabIndex={0}>
      <span className="kind">
        <St kind={row.sev}>{row.kind}</St>
      </span>
      <div className="what">
        <b>{row.title}</b>
        <div>{row.sub}</div>
      </div>
      <span className="when">{ago(row.at, now)}</span>
    </div>
  );
}

// A group opens in place (APG Disclosure): up to five children, each opening its panel
// or view, then a link to the view that lists them all.
function GroupRow({ row }: { row: AttentionRow }) {
  const { now } = useApp();
  const [open, setOpen] = useState(false);
  const id = `att-${row.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const kids = row.children ?? [];
  const view = row.view && isView(row.view.id) ? row.view : null;
  return (
    <>
      <div className={row.sev === "crit" ? "att-row grp sev-crit" : "att-row grp"}>
        <span className="kind">
          <St kind={row.sev}>{row.kind}</St>
        </span>
        <div className="what">
          <button type="button" className="rowlink" data-row="" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            {row.title}
          </button>
          <div>{row.sub}</div>
        </div>
        <span className="when">
          {ago(row.at, now)} <span className="chev" aria-hidden="true" />
        </span>
      </div>
      <div className="att-kids" id={id} hidden={!open}>
        {open && (
          <>
            {kids.map((k) => (
              <div className="att-child" key={`${k.open}|${k.title}`} data-row="" data-open={k.open} tabIndex={0}>
                <div className="what">
                  <b>{k.title}</b>
                  <div>{k.sub}</div>
                </div>
                <span className="when">{ago(k.at, now)}</span>
              </div>
            ))}
            {view && (
              <div className="grouplink">
                <Link href={routePath(view.id as ViewId)}>{(row.total ?? 0) > kids.length ? `All ${row.total} in ${view.label}` : `Open ${view.label}`}</Link>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// One row at the foot of the list, closed: facts with nothing to do now. A group of
// notices (silent drivers) is one line that opens its view, not a second disclosure.
function Notices({ rows, count }: { rows: AttentionRow[]; count: number }) {
  const { now } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div className="notices">
      <div className="att-row grp notice-head">
        <span className="kind">
          <St kind="nodata">Notices</St>
        </span>
        <div className="what">
          <button type="button" className="rowlink" data-row="" aria-expanded={open} aria-controls="att-notices" onClick={() => setOpen(!open)}>
            {count} {count === 1 ? "notice" : "notices"}
          </button>
          <div>Missing data and quiet agents: nothing to act on now</div>
        </div>
        <span className="when">
          <span className="chev" aria-hidden="true" />
        </span>
      </div>
      <div className="att-kids" id="att-notices" hidden={!open}>
        {open &&
          rows.map((r) => (
            <div className="att-child" key={r.key} data-row="" data-open={r.children && r.view ? `view:${r.view.id}` : r.open} tabIndex={0}>
              <div className="what">
                <b>{r.title}</b>
                <div>
                  {r.kind} · {r.sub}
                </div>
              </div>
              <span className="when">{ago(r.at, now)}</span>
            </div>
          ))}
      </div>
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
