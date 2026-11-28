import { StatTile, type StatTileProps, StatTiles } from "capsomer/react/stat-tile";
import { Link } from "../lib/router";
import { placePath, useApp } from "../app/ctx";
import { ciState, hasSites, offaccountState } from "../lib/derive";
import { HOUR, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import "capsomer/stat-tile.css";
import type { OpsFeed } from "../types";
import { incidents } from "../lib/incidents";

type Tile = StatTileProps extends infer P
  ? P extends StatTileProps
    ? Omit<P, "href" | "renderLink"> & { go: string }
    : never
  : never;

function counts(feed: OpsFeed) {
  const sites = hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  return {
    down: sites.filter((s) => s.state === "down").length,
    degraded: sites.filter((s) => s.state === "degraded").length,
    findings: incidents(feed).filter((x) => x.open).length,
    ciRed: (feed.snapshot?.ci ?? []).filter((c) => ciState(c).red).length,
  };
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
      ? {
          label: "Sites up",
          figure: snap.sites.length - c.down - c.degraded,
          unit: `/${snap.sites.length}`,
          detail: `${c.down} down · ${c.degraded} degraded`,
          tone: c.down ? "crit" : c.degraded ? "warn" : "ok",
          go: "sites",
        }
      : {
          label: "Sites up",
          tone: "nodata",
          reason: "no watcher pass yet",
          go: "sites",
        };
  const tiles: Tile[] = [
    ...(siteTile ? [siteTile] : []),
    {
      label: "Open findings",
      figure: findingsOpen,
      detail: snap ? `watcher pass ${ago(parse(snap.pass_at), now)}` : "no watcher pass yet",
      tone: findingsOpen ? "warn" : "ok",
      go: "health#problems",
    },
    backup && backup.age_hours != null
      ? {
          label: "Backup",
          figure: backup.age_hours.toFixed(1),
          unit: "h",
          detail:
            backup.warning ??
            (backup.last_ok
              ? `last good dump ${ago(parse(backup.last_ok), now)}`
              : "no good dump recorded"),
          tone: backup.warning ? "crit" : "ok",
          go: "health#backups",
        }
      : snap?.health
        ? {
            label: "Backup",
            figure: "No data",
            detail: "no good dump recorded",
            tone: "crit",
            go: "health#backups",
          }
        : {
            label: "Backup",
            tone: "nodata",
            reason: "health not read",
            go: "health#backups",
          },
    copy && copyState
      ? {
          label: "Amazon copy",
          figure: copyState.worst == null ? "No copy" : (copyState.worst / HOUR).toFixed(0),
          unit: copyState.worst == null ? undefined : "h",
          detail:
            copyState.bad || copyState.warn
              ? copyState.headline
              : `oldest of ${copy.sites.length} sites · ${copyState.detail.toLowerCase()}`,
          tone: copyState.bad ? "crit" : copyState.warn ? "warn" : "ok",
          go: "health#backups",
        }
      : snap
        ? {
            label: "Amazon copy",
            figure: "No data",
            detail: "not read on the last pass",
            tone: "warn",
            go: "health#backups",
          }
        : {
            label: "Amazon copy",
            tone: "nodata",
            reason: "no watcher pass yet",
            go: "health#backups",
          },
  ];
  return (
    <div className="cap-stack" id="summary">
      {/* A tile is never narrower than its text, so the row wraps instead of cutting a word (design D3). */}
      <StatTiles label="Health figures">
        {tiles.map(({ go, ...t }) => (
          <StatTile
            key={t.label}
            {...t}
            href={placePath(go)}
            renderLink={({ href, ...props }) => <Link href={href} {...props} />}
          />
        ))}
      </StatTiles>
    </div>
  );
}
