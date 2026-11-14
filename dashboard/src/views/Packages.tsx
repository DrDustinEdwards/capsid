import { Alert, Banner } from "capsomer/react/banner";
import { Suspense, lazy, useState } from "react";
import { useApp } from "../app/ctx";
import { fetchPackageHistory } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { ago } from "../lib/format";
import { shortCount } from "capsomer/behavior/format";
import { parse } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import type { OpsPackageConfig, PackageSnapshot } from "../types";
import { Panel } from "capsomer/react/panel";
import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { useDemo } from "../lib/router";
import { useEditor } from "capsomer/react/config-form";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

const DownloadsChart = trendChart("DownloadsChart");

// The Shared code and Completeness tabs load when opened, and the add and edit form the first
// time it opens, so Published's first paint carries neither.
const SharedCode = lazy(() =>
  import("./SharedCode").then((m) => ({ default: m.SharedCode })),
);
const Completeness = lazy(() =>
  import("./Completeness").then((m) => ({ default: m.Completeness })),
);
const PackageForm = lazy(() =>
  import("./PackageConfig").then((m) => ({ default: m.PackageForm })),
);
import { PACKAGE_TABS, tabOf } from "../app/ctx";
import { NoSnapshot, PageHead } from "./shared";

// The Packages panels (capsid/decisions.md, 2026-09-29): one panel per package configured
// here, with Add package above them and Edit on each, as the watcher's last pass read it (src/ops-packages.ts), and
// the daily download history when asked for. Dependents are counts from deps.dev: no
// public API lists them, so the lists are links to npmjs.com's and deps.dev's pages.

function Part({
  part,
  children,
}: {
  part: { state: "ok" } | { state: "none" | "error"; reason: string };
  children: () => React.ReactNode;
}) {
  if (part.state === "ok") return <>{children()}</>;
  return part.state === "none" ? (
    <span className="cap-text" data-tone="dim">
      {part.reason}
    </span>
  ) : (
    <Status tone="nodata">Could not read: {part.reason}</Status>
  );
}

function HistoryPanel({ name }: { name: string }) {
  // Read when asked for: the history is a large read the panel does not need. The chart demo reads
  // it at once (sample data, captured at build time), so its download chart is on the page for a
  // visitor and the live chart check (devkit live/areas.json, area 10), not behind a button.
  const demo = useDemo();
  const [asked, setAsked] = useState(demo);
  const h = useAnswer(
    ["packages", "history", name],
    () => fetchPackageHistory(name),
    {
      enabled: asked,
    },
  );
  if (!h.data && !h.error) {
    return (
      <button
        type="button"
        className="cap-btn"
        disabled={h.loading}
        onClick={() => setAsked(true)}
      >
        {h.loading ? "Reading npm…" : "Load the daily download history"}
      </button>
    );
  }
  if (!h.data)
    return <Alert tone="warn">The history could not be read: {h.error}</Alert>;
  const d = h.data;
  const byName = new Map<string, number>();
  for (const day of d.days)
    byName.set(day.name, (byName.get(day.name) ?? 0) + day.downloads);
  return (
    <div className="cap-stack" data-gap="4" data-history={d.name}>
      <ChartSlot>
        <DownloadsChart data={d} />
      </ChartSlot>
      <p className="cap-text note" data-size="small" data-tone="dim">
        {[...byName]
          .map(([n, total]) => `${n}: ${shortCount(total)}`)
          .join(" · ")}{" "}
        · read from npm {d.fetched_at.slice(0, 16).replace("T", " ")} UTC, kept
        six hours
      </p>
      {d.notes.map((n) => (
        <p key={n} className="cap-text note" data-size="small">
          {n}
        </p>
      ))}
      {d.weeks.length > 0 && (
        <table className="cap-table">
          <thead>
            <tr>
              <th>Week</th>
              <th>Stars</th>
              <th>Open issues</th>
              <th>Open PRs</th>
              <th>Latest release</th>
            </tr>
          </thead>
          <tbody>
            {d.weeks.slice(0, 8).map((w) => (
              <tr key={w.week}>
                <td className="cap-num">{w.week}</td>
                <td className="cap-num">{w.stars}</td>
                <td className="cap-num">{w.open_issues}</td>
                <td className="cap-num">{w.open_prs}</td>
                <td className="cap-mono">{w.latest_release ?? "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PackagePanel({
  cfg,
  snap,
  onEdit,
}: {
  cfg: OpsPackageConfig;
  snap: PackageSnapshot | null;
  onEdit: () => void;
}) {
  const { now } = useApp();
  const enc = encodeURIComponent(cfg.name);
  return (
    <Panel
      flush
      title={cfg.name}
      src={
        <>
          {snap ? `read ${ago(parse(snap.at), now)} · ` : "not read yet · "}
          <button
            type="button"
            className="cap-btn"
            aria-label={`Edit ${cfg.name}`}
            onClick={onEdit}
          >
            Edit
          </button>
        </>
      }
    >
      <div className="body cap-stack" data-gap="4" data-package={cfg.name}>
        {!snap ? (
          <p className="cap-text" data-tone="dim">
            The watcher reads this package on its next pass.
          </p>
        ) : (
          <dl className="cap-detail-record">
            <dt>Version</dt>
            <dd>
              <Part part={snap.npm}>
                {() =>
                  snap.npm.state === "ok" && (
                    <>
                      <span className="cap-mono">
                        {snap.npm.latest ?? "no latest tag"}
                      </span>{" "}
                      <span className="cap-text" data-tone="dim">
                        {Object.entries(snap.npm.dist_tags)
                          .map(([t, v]) => `${t} ${v}`)
                          .join(" · ")}{" "}
                        · {snap.npm.versions} published
                      </span>
                    </>
                  )
                }
              </Part>
            </dd>
            <dt>Downloads</dt>
            <dd>
              <Part part={snap.downloads}>
                {() =>
                  snap.downloads.state === "ok" && (
                    <>
                      <span className="cap-num">
                        {shortCount(snap.downloads.last_week)}
                      </span>{" "}
                      in 7 days ·{" "}
                      <span className="cap-num">
                        {shortCount(snap.downloads.last_month)}
                      </span>{" "}
                      in 30 days
                      <span className="cap-text" data-tone="dim">
                        {" "}
                        {snap.downloads.through
                          ? `(counted to ${snap.downloads.through})`
                          : "(npm has no counts yet)"}
                      </span>
                      {Object.keys(snap.downloads.by_version_last_week).length >
                        0 && (
                        <div
                          className="cap-text hint"
                          data-size="small"
                          data-tone="dim"
                        >
                          Per version, last 7 days only (npm keeps no
                          per-version history):{" "}
                          {Object.entries(snap.downloads.by_version_last_week)
                            .sort((a, b) => b[1] - a[1])
                            .map(([v, n]) => `${v} ${shortCount(n)}`)
                            .join(" · ")}
                        </div>
                      )}
                    </>
                  )
                }
              </Part>
            </dd>
            <dt>Dependents</dt>
            <dd>
              <Part part={snap.dependents}>
                {() =>
                  snap.dependents.state === "ok" && (
                    <>
                      <span className="cap-num">
                        {shortCount(snap.dependents.total)}
                      </span>{" "}
                      packages depend on {snap.dependents.version}:{" "}
                      {shortCount(snap.dependents.direct)} directly,{" "}
                      {shortCount(snap.dependents.indirect)} through another
                      package
                    </>
                  )
                }
              </Part>
              <div className="cap-text hint" data-size="small">
                Counts from deps.dev, which it calls indicative rather than
                exact. No public API lists them:{" "}
                <a
                  href={`https://www.npmjs.com/package/${enc}?activeTab=dependents`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  npm's list
                </a>{" "}
                ·{" "}
                <a
                  href={`https://deps.dev/npm/${enc}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  deps.dev
                </a>
                . GitHub offers no API for the repositories that use it.
              </div>
            </dd>
            <dt>Repository</dt>
            <dd>
              <Part part={snap.github}>
                {() =>
                  snap.github.state === "ok" && (
                    <>
                      <a
                        href={`https://github.com/${snap.github.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span className="cap-mono">{snap.github.repo}</span>
                      </a>{" "}
                      · <span className="cap-num">{snap.github.stars}</span>{" "}
                      stars ·{" "}
                      <span className="cap-num">{snap.github.open_issues}</span>{" "}
                      open issues ·{" "}
                      <span className="cap-num">
                        {snap.github.open_prs}
                        {snap.github.open_prs_capped ? "+" : ""}
                      </span>{" "}
                      open PRs ·{" "}
                      {snap.github.latest_release ? (
                        <span className="cap-mono">
                          {snap.github.latest_release.tag}
                        </span>
                      ) : (
                        "no release"
                      )}
                    </>
                  )
                }
              </Part>
            </dd>
            {cfg.formerly && (
              <>
                <dt>Formerly</dt>
                <dd className="cap-mono">{cfg.formerly}</dd>
              </>
            )}
          </dl>
        )}
        <HistoryPanel name={cfg.name} />
      </div>
    </Panel>
  );
}

// One page for one kind of thing (the UX audit's m1; the Portal audit's new map, 2026-11-06):
// Published, the npm packages, added and changed here; Shared, the git-pinned packages the apps
// share; and Completeness, devkit's scoreboard of every area of that shared code on every live
// site. Each Worker's secrets and stores are on its site's Setup tab, and those no site owns on
// Health's Cloudflare tab. The tab is in the address (?tab=shared).
export function Packages() {
  const tab = tabOf(PACKAGE_TABS, useTabParam()) ?? PACKAGE_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Packages" />
      <PageTabs
        label="Packages"
        path="/packages"
        tabs={PACKAGE_TABS}
        current={tab}
      />
      <div className="cap-stack" id={tab}>
        {tab === "shared" ? (
          <Suspense fallback={null}>
            <SharedCode />
          </Suspense>
        ) : tab === "complete" ? (
          <Suspense fallback={null}>
            <Completeness />
          </Suspense>
        ) : (
          <Published />
        )}
      </div>
    </div>
  );
}

function Published() {
  const { feed } = useApp();
  const ed = useEditor<OpsPackageConfig>();
  const byName = new Map(
    (feed.snapshot?.packages ?? []).map((p) => [p.name, p]),
  );
  const rows = feed.live.packages;
  return (
    <>
      <div className="cap-cluster" data-gap="3">
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          onClick={ed.add}
          disabled={ed.editing?.kind === "add"}
        >
          Add package
        </button>
      </div>
      {ed.editing && (
        <Suspense fallback={null}>
          <PackageForm
            key={ed.formKey}
            editing={ed.editing}
            onClose={ed.close}
          />
        </Suspense>
      )}
      {!rows.length && (
        <Banner tone="neutral">
          No package is configured yet. Add one to watch its versions, downloads
          and dependents.
        </Banner>
      )}
      {rows.length > 0 && !feed.snapshot && <NoSnapshot />}
      {rows.map((cfg) => (
        <PackagePanel
          key={cfg.name}
          cfg={cfg}
          snap={byName.get(cfg.name) ?? null}
          onEdit={() => ed.edit(cfg, cfg.name)}
        />
      ))}
    </>
  );
}
