import type { ReactNode } from "react";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import "capsomer/stat-tile.css";
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

type Tile = {
  label: string;
  d: string;
  // A page, or a page and its tab ("health#backups"), as placePath reads it.
  go: string;
} & (
  | { tone: "ok" | "warn" | "crit"; figure: ReactNode; unit?: string }
  | { tone: "nodata"; reason: string }
);

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
          d: `${c.down} down · ${c.degraded} degraded`,
          tone: c.down ? "crit" : c.degraded ? "warn" : "ok",
          go: "sites",
        }
      : {
          label: "Sites up",
          tone: "nodata",
          reason: "No data",
          d: "no watcher pass yet",
          go: "sites",
        };
  const tiles: Tile[] = [
    ...(siteTile ? [siteTile] : []),
    {
      label: "Open findings",
      figure: String(findingsOpen),
      d: snap ? `watcher pass ${ago(ms(snap.pass_at), now)}` : "no watcher pass yet",
      tone: findingsOpen ? "warn" : "ok",
      go: "health#problems",
    },
    backup && backup.age_hours != null
      ? {
          label: "Backup",
          figure: backup.age_hours.toFixed(1),
          unit: "h",
          d:
            backup.warning ??
            (backup.last_ok
              ? `last good dump ${ago(ms(backup.last_ok), now)}`
              : "no good dump recorded"),
          tone: backup.warning ? "crit" : "ok",
          go: "health#backups",
        }
      : {
          label: "Backup",
          tone: "nodata",
          reason: "No data",
          d: snap?.health ? "no good dump recorded" : "health not read",
          go: "health#backups",
        },
    copy && copyState
      ? copyState.worst == null
        ? {
            label: "Amazon copy",
            tone: "nodata",
            reason: "No copy",
            d:
              copyState.bad || copyState.warn ? copyState.headline : copyState.detail.toLowerCase(),
            go: "health#backups",
          }
        : {
            label: "Amazon copy",
            figure: (copyState.worst / HOUR).toFixed(0),
            unit: "h",
            d:
              copyState.bad || copyState.warn
                ? copyState.headline
                : `oldest of ${copy.sites.length} sites · ${copyState.detail.toLowerCase()}`,
            tone: copyState.bad ? "crit" : copyState.warn ? "warn" : "ok",
            go: "health#backups",
          }
      : {
          label: "Amazon copy",
          tone: "nodata",
          reason: "No data",
          d: snap ? "not read on the last pass" : "no watcher pass yet",
          go: "health#backups",
        },
  ];
  return (
    <div className="embedded" id="summary">
      <StatTiles label="Overview">
        {tiles.map((t) => (
          <StatTile
            key={t.label}
            label={t.label}
            detail={t.d}
            href={placePath(t.go)}
            renderLink={({ href, className, children, ...rest }) => (
              <Link href={href} className={className} {...rest}>
                {children}
              </Link>
            )}
            {...(t.tone === "nodata"
              ? { tone: "nodata" as const, reason: t.reason }
              : { tone: t.tone, figure: t.figure, unit: t.unit })}
          />
        ))}
      </StatTiles>
    </div>
  );
}
