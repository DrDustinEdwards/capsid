import type { ReactNode } from "react";
import { useApp, type ViewId } from "../app/ctx";
import { attentionItems, counts, hasSites, isOpen } from "../lib/derive";
import { DAY, age, ago, ms } from "../lib/format";
import { Icon, St } from "../ui/icons";
import { FleetTable, IncidentFeed, NoSnapshot, PageHead, Panel, QueueRows, TimelinePanel } from "./shared";

interface Tile {
  label: string;
  v: ReactNode;
  d: string;
  cls: "" | "ok" | "warn" | "crit";
  go: ViewId;
}

export function Overview() {
  const { feed, now, go } = useApp();
  const att = attentionItems(feed, now);
  const c = counts(feed);
  const snap = feed.snapshot;
  const live = feed.live;
  const blocked = live.jobs.filter((j) => j.status === "blocked");
  const budget = live.loop.budget;
  const minutesFrac = budget.caps.actions_minutes_month ? budget.spend.ci_minutes / budget.caps.actions_minutes_month : 0;
  const backup = snap?.health?.backup ?? null;
  const mirrorAge = snap?.mirror?.newest_dump ? now - ms(snap.mirror.newest_dump) : null;
  const findingsOpen = c.findings;
  // Site monitoring is optional: with no site configured, no site tile, fleet or timeline.
  const sitesOn = hasSites(feed);
  const siteTile: Tile | null = !sitesOn
    ? null
    : snap
      ? { label: "Sites up", v: <>{snap.sites.length - c.down - c.degraded}<small>/{snap.sites.length}</small></>, d: `${c.down} down · ${c.degraded} degraded`, cls: c.down ? "crit" : c.degraded ? "warn" : "ok", go: "sites" }
      : { label: "Sites up", v: <small>No data</small>, d: "no watcher pass yet", cls: "", go: "sites" };
  const tiles: Tile[] = [
    ...(siteTile ? [siteTile] : []),
    { label: "Blocked on you", v: String(c.blocked), d: blocked.length ? `oldest ${age(Math.min(...blocked.map((j) => ms(j.updated_at))), now)}` : "nothing waiting", cls: c.blocked ? "warn" : "ok", go: "queue" },
    { label: "Running", v: <>{c.running}<small> · {c.queued} queued</small></>, d: `across ${new Set(live.jobs.filter(isOpen).map((j) => j.namespace)).size} namespaces`, cls: "", go: "queue" },
    backup && backup.age_hours != null
      ? { label: "Primary backup", v: <>{backup.age_hours.toFixed(1)}<small>h</small></>, d: mirrorAge == null ? "mirror: no data" : `mirror ${Math.floor(mirrorAge / DAY)}d old`, cls: backup.warning || (mirrorAge != null && mirrorAge > 2 * DAY) ? "crit" : "ok", go: "backups" }
      : { label: "Primary backup", v: <small>No data</small>, d: snap?.health ? "no good dump recorded" : "health not read", cls: snap?.health ? "crit" : "", go: "backups" },
    { label: "Open findings", v: String(findingsOpen), d: snap ? `watcher pass ${ago(ms(snap.pass_at), now)}` : "no watcher pass yet", cls: findingsOpen ? "warn" : "ok", go: "incidents" },
    { label: "Actions budget", v: <>{budget.spend.ci_minutes}<small>/{budget.caps.actions_minutes_month} min</small></>, d: `$${budget.spend.cost_usd.toFixed(2)} of $${budget.caps.model_usd_month} · loop ${live.loop.mode}`, cls: budget.exceeded ? "crit" : minutesFrac > 0.8 ? "warn" : "", go: "agents" },
  ];
  return (
    <div className="page">
      <PageHead title="Overview">Everything that is not fine, first. Then the fleet, the week of deploys, and the queue.</PageHead>
      <section className="attention" aria-labelledby="attH">
        <header>
          <h2 id="attH">Needs attention</h2>
          <span className="mono faint">{att.length} items</span>
          <span className="src ml-auto">worst first · {sitesOn ? "sites, " : ""}backups, CI, queue, watcher, agents</span>
        </header>
        {att.length ? (
          att.map((a, i) => (
            <div className="att-row" key={`${a.kind}-${a.title}-${i}`} data-row="" data-open={a.open} tabIndex={0}>
              <span className={`stripe ${a.sev}`} />
              <span className="kind">
                <St kind={a.sev}>{a.kind}</St>
              </span>
              <div className="what">
                <b>{a.title}</b>
                <div>{a.sub}</div>
              </div>
              <span className="when">{ago(a.at, now)}</span>
            </div>
          ))
        ) : (
          <div className="allclear">
            <Icon kind="ok" /> All clear. Nothing needs you.
          </div>
        )}
      </section>
      <div className={sitesOn ? "tiles" : "tiles five"}>
        {tiles.map((t) => (
          <button type="button" key={t.label} className={`tile ${t.cls}`} onClick={() => go(t.go)}>
            <span className="label">{t.label}</span>
            <span className="v">{t.v}</span>
            <span className="d">{t.d}</span>
          </button>
        ))}
      </div>
      {sitesOn && (
        <>
          <Panel title="Fleet" src={snap ? `watcher pass ${ago(ms(snap.pass_at), now)} · KV ops:snapshot` : "KV ops:snapshot"}>
            {snap ? <FleetTable sites={snap.sites} /> : <div className="body"><NoSnapshot /></div>}
          </Panel>
          <TimelinePanel title="Deploys and downtime, 7 days" days={7} src="Cloudflare deployments · probe ring" />
        </>
      )}
      <div className="grid2">
        <Panel title="Queue" src="live · D1 jobs">
          <QueueRows jobs={live.jobs} compact />
        </Panel>
        <Panel title="Incidents" src="watcher findings">
          <IncidentFeed limit={6} />
        </Panel>
      </div>
    </div>
  );
}
