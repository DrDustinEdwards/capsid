import type { ReactNode } from "react";
import { Link } from "../lib/router";
import { placePath, useApp } from "../app/ctx";
import { counts, hasSites, offaccountState } from "../lib/derive";
import { HOUR, ago, ms } from "../lib/format";

// The tiles at the top of Health (docs/design/design-portal-evaluation.md section 2; the UX
// audit's m2 and m3, 2026-10): sites up, open findings, the primary backup and the
// Amazon backup copy, each a link to the tab that holds it. Backup and Amazon copy are two
// tiles, so a stale copy never turns a good primary backup red. What waits on you is
// counted on Needs you only, so there is no "Blocked on you" tile. With no site configured
// there is no site tile.

interface Tile {
  label: string;
  v: ReactNode;
  d: string;
  cls: "" | "ok" | "warn" | "crit";
  // A view id, or a retired one that placePath maps to its page and section.
  go: string;
}

export function Overview() {
  const { feed, now } = useApp();
  const c = counts(feed);
  const snap = feed.snapshot;
  const backup = snap?.health?.backup ?? null;
  const copy = snap?.offaccount ?? null;
  const copyState = copy ? offaccountState(copy, now) : null;
  const findingsOpen = c.findings;
  const sitesOn = hasSites(feed);
  const siteTile: Tile | null = !sitesOn
    ? null
    : snap
      ? { label: "Sites up", v: <>{snap.sites.length - c.down - c.degraded}<small>/{snap.sites.length}</small></>, d: `${c.down} down · ${c.degraded} degraded`, cls: c.down ? "crit" : c.degraded ? "warn" : "ok", go: "sites" }
      : { label: "Sites up", v: <small>No data</small>, d: "no watcher pass yet", cls: "", go: "sites" };
  const tiles: Tile[] = [
    ...(siteTile ? [siteTile] : []),
    { label: "Open findings", v: String(findingsOpen), d: snap ? `watcher pass ${ago(ms(snap.pass_at), now)}` : "no watcher pass yet", cls: findingsOpen ? "warn" : "ok", go: "incidents" },
    backup && backup.age_hours != null
      ? { label: "Backup", v: <>{backup.age_hours.toFixed(1)}<small>h</small></>, d: backup.warning ?? (backup.last_ok ? `last good dump ${ago(ms(backup.last_ok), now)}` : "no good dump recorded"), cls: backup.warning ? "crit" : "ok", go: "backups" }
      : { label: "Backup", v: <small>No data</small>, d: snap?.health ? "no good dump recorded" : "health not read", cls: snap?.health ? "crit" : "", go: "backups" },
    copy && copyState
      ? {
          label: "Amazon copy",
          v: copyState.worst == null ? <small>No copy</small> : <>{(copyState.worst / HOUR).toFixed(0)}<small>h</small></>,
          d: copyState.bad || copyState.warn ? copyState.headline : `oldest of ${copy.sites.length} sites · ${copyState.detail.toLowerCase()}`,
          cls: copyState.bad ? "crit" : copyState.warn ? "warn" : "ok",
          go: "backups",
        }
      : { label: "Amazon copy", v: <small>No data</small>, d: snap ? "not read on the last pass" : "no watcher pass yet", cls: snap ? "warn" : "", go: "backups" },
  ];
  return (
    <div className="embedded" id="summary">
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
          return (
            <Link key={t.label} href={placePath(t.go)} className={`tile ${t.cls}`}>
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
