import { Suspense, lazy, type ReactNode } from "react";
import { Link } from "wouter";
import { placePath, useApp } from "../app/ctx";
import { counts, hasSites, isOpen } from "../lib/derive";
import { DAY, age, ago, ms } from "../lib/format";

// The top of Health (docs/design/design-portal-evaluation.md section 2: "Overview: its tiles
// move to the top of Health"): six summary tiles and the daily maintenance pass's list
// (job_549550d73d4e). The Overview's brief site table and week of deploys are not repeated:
// Health's Sites and Deploys sections are the whole of both. With no site configured there
// is no site tile.

interface Tile {
  label: string;
  v: ReactNode;
  d: string;
  cls: "" | "ok" | "warn" | "crit";
  // A view id, or a retired one that placePath maps to its page and section.
  go: string;
}

// The Maintenance list loads on its own, after the Overview's first paint.
const Maintenance = lazy(() => import("./Maintenance").then((m) => ({ default: m.Maintenance })));

export function Overview() {
  const { feed, now } = useApp();
  const c = counts(feed);
  const snap = feed.snapshot;
  const live = feed.live;
  const blocked = live.jobs.filter((j) => j.status === "blocked");
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
  ];
  return (
    <div className="embedded" id="summary" data-section="Summary">
      {/* Figure and label on one line, the detail under them; a tile is never narrower
          than its text, so the row wraps instead of cutting a word (design D3). */}
      <div className="tiles">
        {tiles.map((t) => {
          const body = (
            <>
              <span className="t1">
                <span className="v">{t.v}</span>
                <span className="l">{t.label}</span>
              </span>
              <span className="d">{t.d}</span>
            </>
          );
          // A section of Health, this page, is a plain in-page link, so the browser jumps.
          const to = placePath(t.go);
          return to.startsWith("/health#") ? (
            <a key={t.label} href={to.slice("/health".length)} className={`tile ${t.cls}`}>
              {body}
            </a>
          ) : (
            <Link key={t.label} href={to} className={`tile ${t.cls}`}>
              {body}
            </Link>
          );
        })}
      </div>
      <Suspense fallback={null}>
        <Maintenance />
      </Suspense>
    </div>
  );
}
