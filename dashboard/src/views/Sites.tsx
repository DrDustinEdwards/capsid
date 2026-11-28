import { Banner } from "capsomer/react/banner";
import type { OpsSiteConfig, SiteSnapshot } from "../types";
import { SITES_TABS, sitePath, tabOf, useApp } from "../app/ctx";
import { Link } from "../lib/router";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Panel } from "capsomer/react/panel";
import { Uptime90 } from "./Uptime90";
import { Deploys } from "./Deploys";
import { useEditor } from "capsomer/react/config-form";
import { Suspense, lazy } from "react";
import { Missing } from "capsomer/react/empty";
import { Spinner } from "capsomer/react/skeleton";
import { parse, utc } from "capsomer/behavior/time";
import { ago, hostOf, pct, shortId } from "../lib/format";
import { shortCount } from "capsomer/behavior/format";
import { Meter } from "capsomer/react/meter";
import { BACKUP_TARGET_HOURS, KIND_STATUS, PROBE, cfOk, cfShort, siteKey } from "../lib/derive";
import { ErrorSpark, UptimeFoot, UptimeTicks, errorTotals } from "../ui/charts";
import { Pill, Status } from "capsomer/react/status";
import { FilterEmpty, NoSnapshot, NsChips, PageHead, useNsFilter } from "./shared";

const SiteForm = lazy(() => import("./SiteConfig").then((m) => ({ default: m.SiteForm })));

export function Sites() {
  const tab = tabOf(SITES_TABS, useTabParam()) ?? SITES_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Sites" />
      <PageTabs label="Sites" path="/sites" tabs={SITES_TABS} current={tab} />
      {tab === "deploys" ? <Deploys /> : <AllSites />}
    </div>
  );
}

function AllSites() {
  const { feed } = useApp();
  const [ns, setNs] = useNsFilter();
  const ed = useEditor<OpsSiteConfig>();
  const snap = feed.snapshot;
  const configured = feed.live.sites;
  const noSite = configured.filter((s) => s.origin === null);
  const list = (snap?.sites ?? []).filter((s) => ns === "all" || s.namespace === ns);
  const emptied = !!snap && !list.length && snap.sites.length > 0;
  const probed = new Set((snap?.sites ?? []).map((s) => s.namespace));
  const waiting = configured.filter((s) => s.origin !== null && !probed.has(s.namespace));
  return (
    <div className="cap-stack">
      <div className="cap-cluster" data-gap="3">
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          onClick={ed.add}
          disabled={ed.editing?.kind === "add"}
        >
          Add site
        </button>
        {snap && <NsChips list={snap.sites.map((s) => s.namespace)} />}
      </div>
      {ed.editing && (
        <Suspense fallback={<Spinner />}>
          <SiteForm key={ed.formKey} editing={ed.editing} onClose={ed.close} />
        </Suspense>
      )}
      {!configured.some((s) => s.origin !== null) ? (
        <Banner tone="neutral">No site configured.</Banner>
      ) : !snap ? (
        <NoSnapshot />
      ) : (
        <Panel flush title="Every site" count={snap.sites.length}>
          {emptied ? (
            <FilterEmpty onShowAll={() => setNs("all")}>No site in the project {ns}.</FilterEmpty>
          ) : (
            <FleetTable sites={list} />
          )}
        </Panel>
      )}
      {waiting.length > 0 && (
        <Banner tone="neutral">
          Waiting for the next pass:{" "}
          {waiting.map((s, i) => (
            <span key={s.namespace}>
              {i > 0 ? ", " : ""}
              <Link href={sitePath(s.namespace)}>{s.name}</Link>
            </span>
          ))}
          .
        </Banner>
      )}
      <Uptime90 ns={ns} />
      {noSite.length > 0 && (
        <Panel flush title="Projects with no site" count={noSite.length}>
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Name</th>
                  <th>Origin</th>
                  <th>Health path</th>
                  <th>Platform</th>
                  <th>Worker script</th>
                  <th>Revision</th>
                  <th>
                    <span className="cap-sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {noSite.map((s) => (
                  <SiteRow key={s.namespace} s={s} onEdit={() => ed.edit(s, s.namespace)} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function SiteRow({ s, onEdit }: { s: OpsSiteConfig; onEdit: () => void }) {
  const { now } = useApp();
  const at = parse(s.updated_at);
  const none = <Missing />;
  return (
    <tr data-row="">
      <td>
        <b className="cap-mono">{s.namespace}</b>
      </td>
      <td data-label="Name">{s.name}</td>
      <td data-label="Origin">
        {s.origin === null ? (
          <Status tone="nodata">Serves no site</Status>
        ) : (
          <>
            <span className="cap-mono">{s.origin}</span>
            {s.self_probe && <div className="src">probed in-process</div>}
          </>
        )}
      </td>
      <td data-label="Health path" className="cap-mono">
        {s.origin === null
          ? none
          : (s.health_path ?? (
              <span className="cap-text" data-tone="dim">
                none, root probed
              </span>
            ))}
      </td>
      <td data-label="Platform">
        {s.platform === "vercel" ? "Vercel" : s.platform === "cloudflare" ? "Cloudflare" : none}
      </td>
      <td data-label="Worker script" className="cap-mono">
        {s.script ?? none}
      </td>
      <td data-label="Revision">
        <span className="cap-num">{s.revision}</span>
        <div className="src" title={Number.isNaN(at) ? s.updated_at : utc(at)}>
          {Number.isNaN(at) ? `updated ${s.updated_at}` : `updated ${ago(at, now)}`}
        </div>
      </td>
      <td className="ctl">
        <button
          type="button"
          className="cap-btn"
          aria-label={`Edit ${s.namespace}`}
          onClick={onEdit}
        >
          Edit
        </button>
      </td>
    </tr>
  );
}

function LiveDeployCell({ s }: { s: SiteSnapshot }) {
  const { now } = useApp();
  const cf = cfOk(s);
  if (!cf)
    return (
      <Status tone="nodata" reason={cfShort(s.cloudflare) ?? ""} brief>
        No data
      </Status>
    );
  const d = cf.deploys[0];
  if (!d)
    return (
      <span className="cap-text" data-tone="dim">
        No deploys recorded
      </span>
    );
  return (
    <>
      <span className="cap-mono">{shortId(d.version_id ?? d.id)}</span>
      <div className="src">
        {ago(parse(d.created_on), now)}
        {d.triggered_by ? ` · ${d.triggered_by}` : ""}
      </div>
    </>
  );
}

function ErrorTotalsCell({ s }: { s: SiteSnapshot }) {
  const cf = cfOk(s);
  if (!cf)
    return (
      <Status tone="nodata" reason={cfShort(s.cloudflare) ?? ""} brief>
        No data
      </Status>
    );
  if (!cf.errors24)
    return (
      <Status tone="nodata" reason="the analytics read failed" brief>
        No data
      </Status>
    );
  const t = errorTotals(cf.errors24);
  const hot = t.rate != null && t.rate > 0.01;
  return (
    <>
      <ErrorSpark
        values={cf.errors24.map((x) => x.errors)}
        label={`Errors per hour for ${s.name}, last 24 hours: ${shortCount(t.err)} of ${shortCount(t.req)} requests`}
      />
      <div className={`src${hot ? " hot" : ""}`}>
        {shortCount(t.err)} / {shortCount(t.req)} · {pct(t.rate)}
      </div>
    </>
  );
}

// Only Capsid's own backup is in the feed; every other site's is no data, never "none" or a zero.

function BackupCell({ s }: { s: SiteSnapshot }) {
  const { feed } = useApp();
  const backup = s.namespace === "capsid" ? feed.snapshot?.health?.backup : undefined;
  if (!backup)
    return (
      <Status tone="nodata" reason="not reported by the site" brief>
        No data
      </Status>
    );
  if (backup.age_hours == null) return <Status tone="crit">Never</Status>;
  const age = backup.age_hours.toFixed(1);
  return (
    <Meter
      size="sm"
      label={<span className="cap-sr-only">Backup age</span>}
      value={Math.min(backup.age_hours, BACKUP_TARGET_HOURS)}
      max={BACKUP_TARGET_HOURS}
      warnAt={0.75}
      critAt={1}
      valueText={`${age} of ${BACKUP_TARGET_HOURS} hours`}
      display={`${age}h / ${BACKUP_TARGET_HOURS}h`}
    />
  );
}

function FleetTable({ sites }: { sites: SiteSnapshot[] }) {
  const { now } = useApp();
  return (
    <div className="cap-table-wrap" data-reflow="wide">
      <table className="cap-table fleet">
        <thead>
          <tr>
            <th>Site</th>
            <th>Status</th>
            <th>Uptime, 2-hour ticks</th>
            <th>Live deploy</th>
            <th>Errors 24h</th>
            <th>
              Backup age <span className="cap-table-note">only Capsid reports one</span>
            </th>
            <th>Probe</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => {
            const p = PROBE[s.state];
            return (
              <tr key={siteKey(s)} data-row="" data-open={`site:${siteKey(s)}`} tabIndex={0}>
                <td className="site">
                  <b>{s.name}</b>
                  <span>{hostOf(s.origin)}</span>
                </td>
                <td data-label="Status">
                  <div className="cap-stack" data-gap="2" data-align="start">
                    <Pill {...KIND_STATUS[p.kind]}>{p.label}</Pill>
                    <div className="src">
                      {s.latency_ms == null ? "no answer" : `${s.latency_ms} ms`}
                    </div>
                  </div>
                </td>
                <td data-label="Uptime, 2-hour ticks" className="uptime-cell">
                  <UptimeTicks site={s} />
                  <UptimeFoot site={s} />
                </td>
                <td data-label="Live deploy">
                  <LiveDeployCell s={s} />
                </td>
                <td data-label="Errors 24h">
                  <ErrorTotalsCell s={s} />
                </td>
                <td data-label="Backup age">
                  <BackupCell s={s} />
                </td>
                <td data-label="Probe">
                  <span className="cap-num">
                    {s.http_status == null ? "no answer" : `HTTP ${s.http_status}`}
                  </span>
                  <div className="src">
                    {s.health_path ?? "/"} · {ago(parse(s.checked_at), now)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
