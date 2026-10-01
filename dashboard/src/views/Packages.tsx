import { useState } from "react";
import { useApp } from "../app/ctx";
import { fetchPackageHistory } from "../lib/api";
import { ago, fmtN, ms } from "../lib/format";
import { St } from "../ui/icons";
import type { OpsPackageConfig, PackageSnapshot, PortalPackageHistory } from "../types";
import { NoSnapshot, PageHead, Panel } from "./shared";

// The optional Packages panel (capsid/decisions.md, 2026-09-29): one panel per package
// configured in Settings, as the watcher's last pass read it (src/ops-packages.ts), and
// the daily download history when asked for. Dependents are counts from deps.dev: no
// public API lists them, so the lists are links to npmjs.com's and deps.dev's pages.

function Part({ part, children }: { part: { state: "ok" } | { state: "none" | "error"; reason: string }; children: () => React.ReactNode }) {
  if (part.state === "ok") return <>{children()}</>;
  return part.state === "none" ? <span className="faint">{part.reason}</span> : <St kind="nodata">Could not read: {part.reason}</St>;
}

type History = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: PortalPackageHistory };

// Daily downloads as an area, the former name's days in the muted tone. Built here, in
// the view's own chunk, rather than in the shared charts, which ship with the overview.
function DownloadsChart({ data }: { data: PortalPackageHistory }) {
  const W = 720;
  const H = 150;
  const B = 18;
  const firstDay = data.days[0];
  const lastDay = data.days[data.days.length - 1];
  if (!firstDay || !lastDay) return <p className="faint">npm has counted no downloads for this package yet.</p>;
  const first = ms(`${firstDay.day}T00:00:00Z`);
  const last = ms(`${lastDay.day}T00:00:00Z`);
  const span = Math.max(1, last - first);
  const max = Math.max(1, ...data.days.map((d) => d.downloads));
  const x = (day: string) => ((ms(`${day}T00:00:00Z`) - first) / span) * (W - 2) + 1;
  const y = (n: number) => H - B - (n / max) * (H - B - 6);
  const total = data.days.reduce((a, d) => a + d.downloads, 0);
  const label = `Daily downloads of ${data.name}${data.formerly ? ` and its former name ${data.formerly}` : ""}, ${data.first_day} to ${data.last_day}: ${fmtN(total)} in all, at most ${fmtN(max)} in a day.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="chart">
      <line x1="0" x2={W} y1={H - B} y2={H - B} stroke="var(--line)" />
      {data.days.map((d) => (
        <line key={`${d.name}-${d.day}`} x1={x(d.day)} x2={x(d.day)} y1={H - B} y2={y(d.downloads)} stroke={d.name === data.name ? "var(--accent)" : "var(--dim)"} strokeWidth="2">
          <title>{`${d.day}: ${fmtN(d.downloads)} (${d.name})`}</title>
        </line>
      ))}
      <text x="2" y={H - 4} fontSize="11" fontFamily="var(--ui)" fill="var(--muted)">
        {data.first_day}
      </text>
      <text x={W - 2} y={H - 4} textAnchor="end" fontSize="11" fontFamily="var(--ui)" fill="var(--muted)">
        {data.last_day}
      </text>
      <text x="2" y="12" fontSize="11" fontFamily="var(--ui)" fill="var(--muted)">
        {`max ${fmtN(max)} a day`}
      </text>
    </svg>
  );
}

function HistoryPanel({ name }: { name: string }) {
  const { signOut } = useApp();
  const [h, setH] = useState<History>({ state: "idle" });
  const load = async () => {
    setH({ state: "loading" });
    const a = await fetchPackageHistory(name);
    if (a.kind === "signed-out") return signOut();
    if (a.kind !== "ok") return setH({ state: "error", message: a.message });
    setH({ state: "ok", data: a.value });
  };
  if (h.state === "idle" || h.state === "loading") {
    return (
      <button type="button" className="btn" disabled={h.state === "loading"} onClick={load}>
        {h.state === "loading" ? "Reading npm…" : "Load the daily download history"}
      </button>
    );
  }
  if (h.state === "error") return <div className="callout warn">The history could not be read: {h.message}</div>;
  const d = h.data;
  const byName = new Map<string, number>();
  for (const day of d.days) byName.set(day.name, (byName.get(day.name) ?? 0) + day.downloads);
  return (
    <div className="stack-gap" data-history={d.name}>
      <DownloadsChart data={d} />
      <p className="note faint">
        {[...byName].map(([n, total]) => `${n}: ${fmtN(total)}`).join(" · ")} · read from npm {d.fetched_at.slice(0, 16).replace("T", " ")} UTC, kept six hours
      </p>
      {d.notes.map((n) => (
        <p key={n} className="note">
          {n}
        </p>
      ))}
      {d.weeks.length > 0 && (
        <table className="list">
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
                <td className="num">{w.week}</td>
                <td className="num">{w.stars}</td>
                <td className="num">{w.open_issues}</td>
                <td className="num">{w.open_prs}</td>
                <td className="mono">{w.latest_release ?? "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PackagePanel({ cfg, snap }: { cfg: OpsPackageConfig; snap: PackageSnapshot | null }) {
  const { now } = useApp();
  const enc = encodeURIComponent(cfg.name);
  return (
    <Panel title={cfg.name} src={snap ? `read ${ago(ms(snap.at), now)}` : "not read yet"}>
      <div className="body stack-gap" data-package={cfg.name}>
        {!snap ? (
          <p className="faint">The watcher reads this package on its next pass.</p>
        ) : (
          <dl className="kv">
            <dt>Version</dt>
            <dd>
              <Part part={snap.npm}>
                {() =>
                  snap.npm.state === "ok" && (
                    <>
                      <span className="mono">{snap.npm.latest ?? "no latest tag"}</span>{" "}
                      <span className="faint">
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
                      <span className="num">{fmtN(snap.downloads.last_week)}</span> in 7 days · <span className="num">{fmtN(snap.downloads.last_month)}</span> in 30 days
                      <span className="faint"> {snap.downloads.through ? `(counted to ${snap.downloads.through})` : "(npm has no counts yet)"}</span>
                      {Object.keys(snap.downloads.by_version_last_week).length > 0 && (
                        <div className="small faint">
                          Per version, last 7 days only (npm keeps no per-version history):{" "}
                          {Object.entries(snap.downloads.by_version_last_week)
                            .sort((a, b) => b[1] - a[1])
                            .map(([v, n]) => `${v} ${fmtN(n)}`)
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
                      <span className="num">{fmtN(snap.dependents.total)}</span> packages depend on {snap.dependents.version}: {fmtN(snap.dependents.direct)} directly,{" "}
                      {fmtN(snap.dependents.indirect)} through another package
                    </>
                  )
                }
              </Part>
              <div className="small">
                Counts from deps.dev, which it calls indicative rather than exact. No public API lists them:{" "}
                <a href={`https://www.npmjs.com/package/${enc}?activeTab=dependents`} target="_blank" rel="noopener noreferrer">
                  npm's list
                </a>{" "}
                ·{" "}
                <a href={`https://deps.dev/npm/${enc}`} target="_blank" rel="noopener noreferrer">
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
                      <a className="mono" href={`https://github.com/${snap.github.repo}`} target="_blank" rel="noopener noreferrer">
                        {snap.github.repo}
                      </a>{" "}
                      · <span className="num">{snap.github.stars}</span> stars · <span className="num">{snap.github.open_issues}</span> open issues ·{" "}
                      <span className="num">
                        {snap.github.open_prs}
                        {snap.github.open_prs_capped ? "+" : ""}
                      </span>{" "}
                      open PRs · {snap.github.latest_release ? <span className="mono">{snap.github.latest_release.tag}</span> : "no release"}
                    </>
                  )
                }
              </Part>
            </dd>
            {cfg.formerly && (
              <>
                <dt>Formerly</dt>
                <dd className="mono">{cfg.formerly}</dd>
              </>
            )}
          </dl>
        )}
        <HistoryPanel name={cfg.name} />
      </div>
    </Panel>
  );
}

export function Packages() {
  const { feed } = useApp();
  const byName = new Map((feed.snapshot?.packages ?? []).map((p) => [p.name, p]));
  return (
    <div className="page">
      <PageHead title="Packages">Each package configured in Settings: its versions, downloads, dependents and repository, as the watcher last read them.</PageHead>
      {!feed.snapshot && <NoSnapshot />}
      {feed.live.packages.map((cfg) => (
        <PackagePanel key={cfg.name} cfg={cfg} snap={byName.get(cfg.name) ?? null} />
      ))}
    </div>
  );
}
