import { Banner } from "capsomer/react/banner";
import { Suspense, lazy, useState } from "react";
import { Empty, Missing } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import "capsomer/page-head.css";
import { Panel } from "capsomer/react/panel";
import { ChartFrame } from "capsomer/react/chart-frame";
import { uptimeStrip } from "enarratio";
import { SITE_TABS, parseRoute, tabOf, useApp, type SiteTab } from "../app/ctx";
import { Link, useLocation } from "../lib/router";
import { padRing, uptimeOf } from "capsomer/behavior/uptime-strip";
import { PROBE, RING_SLOTS, cfNoData, cfOk, siteScripts } from "../lib/derive";
import { ago, hostOf, pct, shortId } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type { OpsSiteConfig, SiteSnapshot } from "../types";
import { NoData, Pill, St } from "../ui/icons";
import { Time } from "capsomer/react/time";
import { ChartSlot } from "../ui/ChartSlot";
import { uptimeOptions } from "../ui/charts";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { trendChart } from "./charts";
import { Convergence, SiteSecrets } from "./Convergence";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";
// The settings form loads the first time Edit is pressed, so the page's first paint does not carry it.
const SiteForm = lazy(() => import("./SiteConfig").then((m) => ({ default: m.SiteForm })));
import { Uptime90 } from "./Uptime90";
import { SiteWorkers } from "./Workers";
import { SearchAndTraffic, SiteBuilds } from "./SiteTraffic";

// ONE SITE'S OWN PAGE (the Portal audit's new map, 2026-11-06), /sites/<namespace>: what was
// spread over Health's Sites and Deploys tabs, the site drawer, Settings' sites list and
// Packages' Workers tab, in one place. Overview: its probe, uptime and errors. Deploys: what
// Cloudflare recorded, and its Workers Builds with their logs. Search and traffic: Search
// Console, Bing and Cloudflare's edge (views/SiteTraffic.tsx). Sync and repairs: its operator
// API, where it opted in. Setup: its row (Edit, Remove), its Worker secrets, its operator key
// (Rotate) and what its Workers bind. The tab is in the
// address (?tab=), so Back, a bookmark and an alert reach it.

// Chart 9 (error rate with deploy markers) is an Enarratio line chart, in the charts' lazy chunk.
const ErrorRate = trendChart("ErrorRate");

export function SitePage() {
  const { feed } = useApp();
  const [location] = useLocation();
  const ns = parseRoute(location).site ?? "";
  const tab: SiteTab = tabOf(SITE_TABS, useTabParam()) ?? SITE_TABS[0].id;
  const row = feed.live.sites.find((s) => s.namespace === ns) ?? null;
  const snap = feed.snapshot?.sites.find((s) => s.namespace === ns) ?? null;
  const name = row?.name ?? snap?.name ?? ns;
  if (!row && !snap) {
    return (
      <div className="cap-admin-page">
        <PageHead title={name} />
        <Empty
          kind="no-match"
          title="No site has this name."
          action={
            <Link className="cap-btn" href="/sites">
              All sites
            </Link>
          }
        >
          No site is configured for the project {ns}. It may have been removed.
        </Empty>
      </div>
    );
  }
  const origin = row?.origin ?? snap?.origin ?? null;
  const p = snap ? PROBE[snap.state] : null;
  return (
    <div className="cap-admin-page">
      <PageHead
        title={name}
        lead={
          <span className="site-lead">
            {p ? <Pill kind={p.kind}>{p.label}</Pill> : <St kind="nodata">Not probed yet</St>}
            {origin ? (
              <a href={origin} target="_blank" rel="noopener noreferrer">
                {hostOf(origin)}
              </a>
            ) : (
              <span className="cap-text" data-tone="dim">
                serves no site
              </span>
            )}
            <span className="cap-text cap-mono" data-tone="dim">
              {ns}
            </span>
          </span>
        }
      />
      <PageTabs
        label={name}
        path={`/sites/${encodeURIComponent(ns)}`}
        tabs={SITE_TABS}
        current={tab}
      />
      <div className="cap-stack" id={tab} data-tab-panel={tab}>
        {tab === "overview" ? (
          <Overview ns={ns} snap={snap} />
        ) : tab === "deploys" ? (
          <>
            <Deploys snap={snap} />
            <SiteBuilds ns={ns} />
          </>
        ) : tab === "traffic" ? (
          <SearchAndTraffic ns={ns} />
        ) : tab === "sync" ? (
          <Convergence ns={ns} />
        ) : (
          <Setup ns={ns} row={row} snap={snap} />
        )}
      </div>
    </div>
  );
}

// ---- Overview ------------------------------------------------------------------------------

// The site's uptime as Capsomer's uptime strip: Enarratio's figure with the week's and the
// day's share up at the end of its title's line, and the key after it.
const UPTIME_KEYS = [
  ["up", "Up"],
  ["degraded", "Degraded"],
  ["down", "Down"],
  ["nodata", "No data"],
] as const;

function SiteUptime({ s }: { s: SiteSnapshot }) {
  const ring = padRing(s.ring, RING_SLOTS);
  const p7 = uptimeOf(ring);
  const p24 = uptimeOf(ring.slice(-48));
  const subtitle = `${p7 == null ? "no data" : pct(p7)} up over 7 days, ${p24 == null ? "no data" : pct(p24, 1)} over 24 hours`;
  return (
    <ChartFrame
      inline
      chart={uptimeStrip({
        ...uptimeOptions(s),
        title: "Uptime, 7 days",
        subtitle,
        source: { name: "The watcher's probes, every half hour" },
      })}
    >
      <ul className="cap-uptime-legend" aria-label="Key">
        {UPTIME_KEYS.map(([key, word]) => (
          <li key={key}>
            <span className="cap-uptime-key" data-key={key} aria-hidden="true" />
            {word}
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

function Overview({ ns, snap }: { ns: string; snap: SiteSnapshot | null }) {
  const { now } = useApp();
  if (!snap) {
    return (
      <Empty kind="nothing-yet" title="Not probed yet.">
        The watcher probes this site from its next pass.
      </Empty>
    );
  }
  const s = snap;
  const p = PROBE[s.state];
  const cf = cfOk(s);
  const detail =
    s.error ??
    (s.state === "liveness"
      ? "No health route; a root 200 is liveness only."
      : s.state !== "ok"
        ? p.label
        : null);
  const healthUrl = s.health_path
    ? s.health_path.startsWith("https://")
      ? s.health_path
      : `${s.origin}${s.health_path}`
    : null;
  return (
    <>
      {detail && (
        <Banner tone={s.state === "down" ? "crit" : s.state === "degraded" ? "warn" : "neutral"}>
          {detail}
        </Banner>
      )}
      <div className="cap-panes" data-even data-gap="5">
        <Panel flush title="Probe" src={`watcher pass · checked ${ago(parse(s.checked_at), now)}`}>
          <div className="body">
            <dl className="cap-detail-record">
              <dt>Checked</dt>
              <dd>
                {ago(parse(s.checked_at), now)} <Time at={s.checked_at} format="exact" />
              </dd>
              <dt>URL</dt>
              <dd className="cap-mono">
                {healthUrl ? (
                  <a href={healthUrl} target="_blank" rel="noopener noreferrer">
                    {healthUrl}
                  </a>
                ) : (
                  `${s.origin}/`
                )}
              </dd>
              <dt>HTTP status</dt>
              <dd className="cap-num">{s.http_status ?? "no answer"}</dd>
              <dt>Latency</dt>
              <dd className="cap-num">
                {s.latency_ms == null ? "no answer" : `${s.latency_ms} ms`}
              </dd>
              <dt>Health route</dt>
              <dd>
                {s.health_path ? (
                  <span className="cap-mono">{s.health_path}</span>
                ) : (
                  <St kind="nodata">none</St>
                )}
              </dd>
              <dt>Reports sha</dt>
              <dd className="cap-mono">
                {s.sha ?? (
                  <span className="cap-text" data-tone="dim">
                    not reported
                  </span>
                )}
              </dd>
              <dt>Platform</dt>
              <dd>{s.platform === "vercel" ? "Vercel" : "Cloudflare"}</dd>
              <dt>Cloudflare script</dt>
              <dd className="cap-mono">
                {cf ? cf.script : <NoData reason={cfNoData(s.cloudflare) ?? ""} />}
              </dd>
            </dl>
          </div>
        </Panel>
        <Panel
          flush
          title="Uptime and errors"
          src="the watcher's probes and Cloudflare's analytics"
        >
          <div className="body cap-stack" data-gap="4">
            <SiteUptime s={s} />
            <ChartSlot>
              <ErrorRate site={s} />
            </ChartSlot>
          </div>
        </Panel>
      </div>
      <Uptime90 ns={ns} />
    </>
  );
}

// ---- Deploys -------------------------------------------------------------------------------

function Deploys({ snap }: { snap: SiteSnapshot | null }) {
  const { now } = useApp();
  const cf = snap ? cfOk(snap) : null;
  return (
    <Panel
      flush
      title="Deploys"
      count={cf?.deploys.length}
      src="Cloudflare's record, at most 10, newest first"
    >
      {!snap ? (
        <div className="cap-text body" data-tone="dim">
          Not probed yet: deploys are read with the watcher's next pass.
        </div>
      ) : !cf ? (
        <div className="body">
          <NoData reason={cfNoData(snap.cloudflare) ?? ""} />
        </div>
      ) : cf.deploys.length ? (
        <div className="cap-table-wrap">
          <table className="cap-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Version</th>
                <th scope="col">Message</th>
                <th scope="col">Triggered by</th>
                <th scope="col">Author</th>
              </tr>
            </thead>
            <tbody>
              {cf.deploys.map((d) => (
                <tr key={d.id}>
                  <td className="cap-num" title={utc(parse(d.created_on))}>
                    {ago(parse(d.created_on), now)}
                  </td>
                  <td className="cap-mono">{shortId(d.version_id ?? d.id)}</td>
                  <td className="cap-muted">{d.message ?? ""}</td>
                  <td className="cap-muted">{d.triggered_by ?? ""}</td>
                  <td className="cap-muted">{d.author_email ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cap-text body" data-tone="dim">
          No deploys recorded.
        </div>
      )}
    </Panel>
  );
}

// ---- Setup ---------------------------------------------------------------------------------

function Setup({
  ns,
  row,
  snap,
}: {
  ns: string;
  row: OpsSiteConfig | null;
  snap: SiteSnapshot | null;
}) {
  const { feed, now, confirm } = useApp();
  const [editing, setEditing] = useState(false);
  const none = <Missing />;
  const at = row ? parse(row.updated_at) : NaN;
  return (
    <>
      {editing && row && (
        <Suspense fallback={null}>
          <SiteForm
            key={`edit:${row.namespace}`}
            editing={{ kind: "edit", row, key: row.namespace }}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      )}
      <Panel
        flush
        title="Settings"
        id="settings"
        section="Settings"
        src={
          row ? (
            <button
              type="button"
              className="cap-btn"
              aria-label={`Edit ${row.namespace}`}
              onClick={() => setEditing(true)}
              disabled={editing}
            >
              Edit
            </button>
          ) : undefined
        }
      >
        {row ? (
          <div className="body">
            <dl className="cap-detail-record">
              <dt>Project</dt>
              <dd className="cap-mono">{row.namespace}</dd>
              <dt>Name</dt>
              <dd>{row.name}</dd>
              <dt>Origin</dt>
              <dd>
                {row.origin === null ? (
                  <St kind="nodata">Serves no site</St>
                ) : (
                  <span className="cap-mono">{row.origin}</span>
                )}
                {row.self_probe && (
                  <span className="cap-text" data-tone="dim">
                    {" "}
                    probed in-process
                  </span>
                )}
              </dd>
              <dt>Health path</dt>
              <dd className="cap-mono">
                {row.origin === null
                  ? none
                  : (row.health_path ?? <Missing>none, root probed</Missing>)}
              </dd>
              <dt>Platform</dt>
              <dd>
                {row.platform === "vercel"
                  ? "Vercel"
                  : row.platform === "cloudflare"
                    ? "Cloudflare"
                    : none}
              </dd>
              <dt>Worker script</dt>
              <dd className="cap-mono">
                {row.script ??
                  (snap && cfOk(snap) ? (
                    <span className="cap-text" data-tone="dim">
                      {cfOk(snap)!.script}, found from the custom domains
                    </span>
                  ) : (
                    none
                  ))}
              </dd>
              <dt>Operator API</dt>
              <dd>
                {row.operator ? (
                  <span className="cap-mono">{row.operator.path}</span>
                ) : row.operator_problem ? (
                  <St kind="warn">{row.operator_problem}</St>
                ) : (
                  none
                )}
              </dd>
              <dt>Revision</dt>
              <dd>
                <span className="cap-num" data-revision="">
                  {row.revision}
                </span>{" "}
                <span
                  className="cap-text"
                  data-tone="dim"
                  title={Number.isNaN(at) ? row.updated_at : utc(at)}
                >
                  {Number.isNaN(at) ? `updated ${row.updated_at}` : `updated ${ago(at, now)}`}
                </span>
              </dd>
            </dl>
          </div>
        ) : (
          <div className="cap-text body" data-tone="dim">
            This site has no settings row: it is in the watcher's last pass only. It leaves the
            Portal on the next pass.
          </div>
        )}
      </Panel>
      {row?.operator && <SiteSecrets ns={ns} />}
      {row?.operator && (
        <Panel
          title="Operator key"
          id="operator-key"
          src="the key Carrel and the admin tools call the site's operator API with"
        >
          <div className="cap-cluster" data-gap="3">
            <button
              type="button"
              className="cap-btn"
              aria-label={`Rotate the operator key of ${row.name}`}
              onClick={() =>
                confirm({
                  action: "site_key_rotate",
                  params: { namespace: ns },
                  title: `Rotate the operator key of ${row.name}`,
                })
              }
            >
              Rotate key
            </button>
            <span className="cap-text note" data-tone="dim" data-size="small">
              A new key is minted and set on the site's Worker, then on Carrel. It is never shown.
            </span>
          </div>
        </Panel>
      )}
      <SiteWorkers scripts={siteScripts(feed, ns)} />
    </>
  );
}
