import { Fragment, useState, type ReactNode } from "react";
import { Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import {
  fetchBuildLog,
  fetchSiteSearch,
  fetchSiteTraffic,
  fetchWorkersBuilds,
  useAnswer,
  type Load,
} from "../lib/api";
import { ago, fmtN, ms, pct, shortId, utc } from "../lib/format";
import type {
  PortalBuildLog,
  PortalSiteSearch,
  PortalSiteTraffic,
  PortalWorkersBuilds,
  SearchRow,
  SiteSource,
  TrafficWebVitals,
  WebVital,
} from "../types";
import { St } from "../ui/icons";
import { NotFound } from "./NotFound";

// A SITE PAGE'S LIVE READS (the Portal audit's new map, 2026-11-06; src/portal-site.ts): search
// (Google Search Console and Bing Webmaster) and traffic (Cloudflare's edge: 404s, 5xx, web
// vitals and AI crawlers) on the Search and traffic tab, and Workers Builds on the Deploys tab.
// Each is read when its tab opens. A source with no data says why (docs/portal.md, "No data is
// a state, never a zero"); the text a source returns (queries, paths, commit messages, logs) is
// strangers' text, shown as text.

// ---- Shared pieces -------------------------------------------------------------------------

// A read's state before its sources: reading, failed, or nothing yet.
function Reading({
  load,
  what,
  children,
}: {
  load: Load<unknown>;
  what: string;
  children: ReactNode;
}) {
  if (!load.data && load.loading) {
    return (
      <div className="loading" role="status">
        <Spinner label={`Reading ${what}...`} />
      </div>
    );
  }
  if (!load.data) {
    return (
      <div className="body">
        <St kind="nodata">No data</St>{" "}
        {load.error ? `The read failed: ${load.error}.` : "No read yet."}
      </div>
    );
  }
  return <>{children}</>;
}

// One source: its rows, or why it has none. "empty" is a read that worked and found nothing.
function Source<T>({ src, children }: { src: SiteSource<T>; children: (data: T) => ReactNode }) {
  if (src.ok) return <>{children(src.data)}</>;
  return (
    <div className="body">
      {src.kind === "empty" ? (
        <span className="faint">{src.reason}</span>
      ) : (
        <>
          <St kind={src.kind === "error" ? "warn" : "nodata"}>
            {src.kind === "error" ? "Not read" : "No data"}
          </St>{" "}
          {src.reason}
        </>
      )}
    </div>
  );
}

// ---- Search --------------------------------------------------------------------------------

function SearchTable({
  rows,
  label,
  more,
}: {
  rows: SearchRow[];
  label: string;
  more?: string | null;
}) {
  if (!rows.length) return <p className="body faint">No {label.toLowerCase()} in the window.</p>;
  return (
    <div className="scroll-x search-rows">
      <table className="list">
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col" className="num">
              Clicks
            </th>
            <th scope="col" className="num">
              Impressions
            </th>
            <th scope="col" className="num">
              CTR
            </th>
            <th scope="col" className="num">
              Position
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className={label === "Pages" ? "mono wrap" : "wrap"}>{r.key}</td>
              <td className="num">{fmtN(r.clicks)}</td>
              <td className="num">{fmtN(r.impressions)}</td>
              <td className="num">{r.ctr == null ? "" : pct(r.ctr, 1)}</td>
              <td className="num">{r.position == null ? "" : r.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more && <p className="body faint">{more}</p>}
    </div>
  );
}

function Totals({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd className="num">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Search({ ns }: { ns: string }) {
  const load = useAnswer<PortalSiteSearch>(["site-search", ns], () => fetchSiteSearch(ns));
  const d = load.data;
  return (
    <div className="grid2">
      <Panel flush title="Google Search" src="Search Console, 28 days ending 3 days ago">
        <Reading load={load} what="Search Console">
          {d && (
            <Source src={d.google}>
              {(g) => (
                <>
                  <div className="body">
                    <p className="faint">
                      {g.property} · {g.start_date} to {g.end_date}
                    </p>
                    <Totals
                      items={[
                        ["Clicks", fmtN(g.totals.clicks)],
                        ["Impressions", fmtN(g.totals.impressions)],
                        ["CTR", g.totals.ctr == null ? "none" : pct(g.totals.ctr, 1)],
                        [
                          "Average position",
                          g.totals.position == null ? "none" : g.totals.position.toFixed(1),
                        ],
                      ]}
                    />
                  </div>
                  <SearchTable
                    label="Queries"
                    rows={g.queries}
                    more={g.queries_truncated ? "The top queries only; more may exist." : null}
                  />
                  <SearchTable
                    label="Pages"
                    rows={g.pages}
                    more={g.pages_truncated ? "The top pages only; more may exist." : null}
                  />
                </>
              )}
            </Source>
          )}
        </Reading>
      </Panel>
      <Panel flush title="Bing Search" src="Bing Webmaster, the same window">
        <Reading load={load} what="Bing Webmaster">
          {d && (
            <Source src={d.bing}>
              {(b) => (
                <>
                  <div className="body">
                    <p className="faint">
                      {b.site} · {b.start_date} to {b.end_date}
                    </p>
                    <Totals
                      items={[
                        ["Clicks", fmtN(b.totals.clicks)],
                        ["Impressions", fmtN(b.totals.impressions)],
                      ]}
                    />
                    {b.note && <p className="faint">{b.note}</p>}
                  </div>
                  <SearchTable
                    label="Queries"
                    rows={b.queries}
                    more={
                      b.queries_total > b.queries.length
                        ? `${b.queries.length} of ${b.queries_total} queries shown.`
                        : null
                    }
                  />
                  <SearchTable
                    label="Pages"
                    rows={b.pages}
                    more={
                      b.pages_total > b.pages.length
                        ? `${b.pages.length} of ${b.pages_total} pages shown.`
                        : null
                    }
                  />
                </>
              )}
            </Source>
          )}
        </Reading>
      </Panel>
    </div>
  );
}

// ---- Traffic -------------------------------------------------------------------------------

// Core Web Vitals and the two diagnostic metrics, rated at the 75th percentile against
// Google's published thresholds (web.dev/articles/vitals; /articles/fcp; /articles/ttfb):
// good at or under the first number, poor over the second.
const VITALS: Array<{ key: WebVital; name: string; good: number; poor: number; unit: "ms" | "" }> =
  [
    {
      key: "largestContentfulPaint",
      name: "Largest Contentful Paint",
      good: 2500,
      poor: 4000,
      unit: "ms",
    },
    {
      key: "interactionToNextPaint",
      name: "Interaction to Next Paint",
      good: 200,
      poor: 500,
      unit: "ms",
    },
    {
      key: "cumulativeLayoutShift",
      name: "Cumulative Layout Shift",
      good: 0.1,
      poor: 0.25,
      unit: "",
    },
    {
      key: "firstContentfulPaint",
      name: "First Contentful Paint",
      good: 1800,
      poor: 3000,
      unit: "ms",
    },
    { key: "timeToFirstByte", name: "Time to First Byte", good: 800, poor: 1800, unit: "ms" },
  ];

const vital = (x: number | null, unit: "ms" | "") =>
  x == null ? "" : unit === "ms" ? `${fmtN(Math.round(x))} ms` : x.toFixed(3);

function Vitals({ v }: { v: TrafficWebVitals }) {
  return (
    <>
      <p className="body faint">
        {fmtN(v.page_views_measured)} page views measured by Cloudflare's browser insights.
      </p>
      <div className="scroll-x">
        <table className="list">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className="num">
                Median
              </th>
              <th scope="col" className="num">
                75th percentile
              </th>
              <th scope="col" className="num">
                90th percentile
              </th>
            </tr>
          </thead>
          <tbody>
            {VITALS.map((m) => {
              const q = v.vitals[m.key];
              const p75 = q?.p75 ?? null;
              const kind =
                p75 == null ? "nodata" : p75 <= m.good ? "ok" : p75 <= m.poor ? "warn" : "crit";
              const word =
                p75 == null
                  ? "No data"
                  : kind === "ok"
                    ? "Good"
                    : kind === "warn"
                      ? "Needs work"
                      : "Poor";
              return (
                <tr key={m.key}>
                  <td>{m.name}</td>
                  <td className="num">{vital(q?.p50 ?? null, m.unit)}</td>
                  <td className="num">
                    {vital(p75, m.unit)} <St kind={kind}>{word}</St>
                  </td>
                  <td className="num">{vital(q?.p90 ?? null, m.unit)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Traffic({ ns }: { ns: string }) {
  const load = useAnswer<PortalSiteTraffic>(["site-traffic", ns], () => fetchSiteTraffic(ns));
  const d = load.data;
  const edge = `Cloudflare's edge, ${d?.days ?? 7} days, sampled`;
  return (
    <div className="grid2">
      <Panel flush title="Missing pages" src={edge}>
        <Reading load={load} what="the 404s">
          {d && (
            <Source src={d.not_found}>
              {(n) => {
                const real = n.paths.filter((p) => !p.probe);
                return (
                  <>
                    {n.note && <p className="body faint">{n.note}</p>}
                    {real.length ? (
                      <div className="scroll-x">
                        <table className="list">
                          <thead>
                            <tr>
                              <th scope="col">Path</th>
                              <th scope="col" className="num">
                                Hits
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {real.map((p) => (
                              <tr key={p.path}>
                                <td className="mono wrap">{p.path}</td>
                                <td className="num">{fmtN(p.hits)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="body faint">No missing page was asked for.</p>
                    )}
                    <p className="body faint">
                      {n.probes} scanner probes not listed
                      {n.truncated ? `; the top paths of ${n.total_paths} only` : ""}.
                    </p>
                  </>
                );
              }}
            </Source>
          )}
        </Reading>
      </Panel>
      <Panel flush title="Server errors" src={edge}>
        <Reading load={load} what="the 5xx">
          {d && (
            <Source src={d.server_errors}>
              {(e) => (
                <>
                  {e.note && <p className="body faint">{e.note}</p>}
                  {e.failures.length ? (
                    <div className="scroll-x">
                      <table className="list">
                        <thead>
                          <tr>
                            <th scope="col">Path</th>
                            <th scope="col" className="num">
                              Status
                            </th>
                            <th scope="col" className="num">
                              Hits
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {e.failures.map((f) => (
                            <tr key={`${f.path} ${f.status}`}>
                              <td className="mono wrap">{f.path}</td>
                              <td className="num">{f.status}</td>
                              <td className="num">{fmtN(f.hits)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {e.truncated && (
                        <p className="body faint">The top failures only; more may exist.</p>
                      )}
                    </div>
                  ) : (
                    <p className="body">
                      <St kind="ok">None</St> No request failed with a 5xx.
                    </p>
                  )}
                </>
              )}
            </Source>
          )}
        </Reading>
      </Panel>
      <Panel flush title="Web vitals" src={`Cloudflare's browser insights, ${d?.days ?? 7} days`}>
        <Reading load={load} what="the web vitals">
          {d && <Source src={d.web_vitals}>{(v) => <Vitals v={v} />}</Source>}
        </Reading>
      </Panel>
      <Panel flush title="AI crawlers" src={edge}>
        <Reading load={load} what="the crawlers">
          {d && (
            <Source src={d.ai_crawlers}>
              {(c) => (
                <>
                  {c.note && <p className="body faint">{c.note}</p>}
                  {c.crawlers.length ? (
                    <div className="scroll-x">
                      <table className="list">
                        <thead>
                          <tr>
                            <th scope="col">Crawler</th>
                            <th scope="col">Kind</th>
                            <th scope="col" className="num">
                              Hits
                            </th>
                            <th scope="col">Answered</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.crawlers.map((r) => (
                            <tr key={r.name}>
                              <td>{r.name}</td>
                              <td className="muted">{CRAWLER_KIND[r.kind] ?? r.kind}</td>
                              <td className="num">{fmtN(r.hits)}</td>
                              <td className="muted">
                                {Object.entries(r.statuses)
                                  .sort((a, b) => b[1] - a[1])
                                  .map(([status, n]) => `${status} × ${fmtN(n)}`)
                                  .join(", ")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.truncated && (
                        <p className="body faint">The top crawlers only; more may exist.</p>
                      )}
                    </div>
                  ) : (
                    <p className="body faint">No known AI crawler visited.</p>
                  )}
                </>
              )}
            </Source>
          )}
        </Reading>
      </Panel>
    </div>
  );
}

// Prelum's robots lists, which the Worker names each crawler by.
const CRAWLER_KIND: Record<string, string> = {
  denied: "Denied",
  training: "Training",
  ai_search: "AI search",
  search: "Search",
};

// The Search and traffic tab. Capsid also keeps its own 404 table, with the hosts that linked
// to each missing page, so its page shows that table too.
export function SearchAndTraffic({ ns }: { ns: string }) {
  return (
    <>
      <Search ns={ns} />
      <Traffic ns={ns} />
      {ns === "capsid" && <NotFound />}
    </>
  );
}

// ---- Workers Builds ------------------------------------------------------------------------

const BUILD: Record<string, { kind: "ok" | "crit" | "warn" | "run" | "nodata"; label: string }> = {
  success: { kind: "ok", label: "Built" },
  fail: { kind: "crit", label: "Failed" },
  failure: { kind: "crit", label: "Failed" },
  // Cloudflare's own outcome value, so its spelling is a data contract.
  cancelled: { kind: "warn", label: "Canceled" }, // codespell:ignore
  canceled: { kind: "warn", label: "Canceled" },
  skipped: { kind: "nodata", label: "Skipped" },
};

function buildState(b: { status: string | null; outcome: string | null }): {
  kind: "ok" | "crit" | "warn" | "run" | "nodata";
  label: string;
} {
  const known = b.outcome ? BUILD[b.outcome] : undefined;
  if (known) return known;
  if (b.status && b.status !== "stopped")
    return { kind: "run" as const, label: b.status === "queued" ? "Queued" : "Building" };
  return { kind: "nodata" as const, label: b.outcome ?? b.status ?? "Unknown" };
}

function BuildLog({ build }: { build: string }) {
  const load = useAnswer<PortalBuildLog>(["build-log", build], () => fetchBuildLog(build), {
    keep: false,
  });
  const d = load.data;
  return (
    <Panel
      flush
      title={`Build log ${shortId(build)}`}
      src="Cloudflare Workers Builds, the last 500 lines"
    >
      <Reading load={load} what="the build log">
        {d && (
          <Source src={d.log}>
            {(l) => (
              <>
                {(l.truncated || l.note) && (
                  <p className="body faint">
                    {l.note ?? `The last ${l.lines.length} of ${l.line_count} lines.`}
                  </p>
                )}
                <pre className="log" role="region" aria-label="Build log" tabIndex={0}>
                  {l.lines.join("\n")}
                </pre>
              </>
            )}
          </Source>
        )}
      </Reading>
    </Panel>
  );
}

export function SiteBuilds({ ns }: { ns: string }) {
  const { now } = useApp();
  const load = useAnswer<PortalWorkersBuilds>(["workers-builds", ns], () => fetchWorkersBuilds(ns));
  const [open, setOpen] = useState<string | null>(null);
  const d = load.data;
  return (
    <>
      <Panel
        flush
        title="Builds"
        count={d?.builds.ok ? d.builds.data.builds.length : undefined}
        src={`Cloudflare Workers Builds${d?.script ? ` for ${d.script}` : ""}, newest first`}
      >
        <Reading load={load} what="the builds">
          {d && (
            <Source src={d.builds}>
              {({ builds }) => (
                <div className="scroll-x">
                  <table className="list">
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">Result</th>
                        <th scope="col">Branch</th>
                        <th scope="col">Commit</th>
                        <th scope="col">Message</th>
                        <th scope="col">
                          <span className="sr-only">Log</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {builds.map((b, i) => {
                        const st = buildState(b);
                        const id = b.build_uuid;
                        return (
                          <tr key={id ?? i}>
                            <td
                              className="num"
                              title={b.created_on ? utc(ms(b.created_on)) : undefined}
                            >
                              {b.created_on ? ago(ms(b.created_on), now) : ""}
                            </td>
                            <td>
                              <St kind={st.kind}>{st.label}</St>
                            </td>
                            <td className="mono">{b.branch ?? ""}</td>
                            <td className="mono">{b.commit ? shortId(b.commit, 7) : ""}</td>
                            <td className="muted wrap">{b.commit_message ?? ""}</td>
                            <td className="ctl">
                              {id && (
                                <button
                                  type="button"
                                  className="cap-btn"
                                  aria-expanded={open === id}
                                  aria-label={`${open === id ? "Hide" : "Show"} the log of build ${shortId(id)}`}
                                  onClick={() => setOpen(open === id ? null : id)}
                                >
                                  {open === id ? "Hide log" : "Log"}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Source>
          )}
        </Reading>
      </Panel>
      {open && <BuildLog build={open} />}
    </>
  );
}
