import { useApp } from "../app/ctx";
import { Spinner } from "capsomer/react/empty";
import { fetchNotFound, useAnswer } from "../lib/api";
import type { PortalNotFound } from "../types";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
import "capsomer/uptime-strip.css";
import { uptimeStrip, type UptimeSlot } from "enarratio";
import { FilterEmpty, FleetTable, NoSnapshot, NsChips, PageHead, useNsFilter } from "./shared";
import { Convergence } from "./Convergence";

export function Sites({ embedded = false }: { embedded?: boolean } = {}) {
  const { feed, now } = useApp();
  const [ns, setNs] = useNsFilter();
  const snap = feed.snapshot;
  const head = embedded ? null : <PageHead title="Sites" />;
  if (!snap) {
    return (
      <div className={embedded ? "embedded" : "page"}>
        {head}
        <NoSnapshot />
      </div>
    );
  }
  const list = snap.sites.filter((s) => ns === "all" || s.namespace === ns);
  const emptied = !list.length && snap.sites.length > 0;
  return (
    <div className={embedded ? "embedded" : "page"}>
      {head}
      <NsChips list={snap.sites.map((s) => s.namespace)} />
      <Panel flush title="Fleet" src={`watcher pass ${ago(ms(snap.pass_at), now)}`}>
        {emptied ? <FilterEmpty onShowAll={() => setNs("all")}>No site in the project {ns}.</FilterEmpty> : <FleetTable sites={list} />}
      </Panel>
      <Uptime90 ns={ns} />
      {(ns === "all" || ns === "capsid") && <NotFound />}
      <Panel flush title="Which sites report their health" src="GET /health returning {status, sha}">
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Site</th>
                <th>Health route</th>
                <th>Reports sha</th>
                <th>Platform</th>
                <th>Cloudflare read</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const cf = cfOk(s);
                return (
                  <tr key={siteKey(s)} className="click" data-row="" data-open={`site:${siteKey(s)}`} tabIndex={0}>
                    <td>
                      <b>{s.name}</b>
                    </td>
                    <td>
                      {s.health_path ? (
                        <>
                          <span className="mono">{s.health_path}</span> {s.state === "degraded" && s.http_status != null && <St kind="warn">{String(s.http_status)}</St>}
                        </>
                      ) : (
                        <St kind="nodata">none</St>
                      )}
                    </td>
                    <td>{s.sha ? <St kind="ok">{s.sha.slice(0, 7)}</St> : <St kind="nodata">no</St>}</td>
                    <td>{s.platform === "vercel" ? "Vercel" : "Cloudflare"}</td>
                    <td>{cf ? <span className="mono">{cf.script}</span> : <span className="faint">{cfNoData(s.cloudflare)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <Convergence ns={ns} />
    </div>
  );
}

// Each site's last 90 UTC days against the 99.9% target, from the five-minute pulse's daily
// counts (ops_uptime_daily), drawn as Capsomer's uptime strip in its table-cell form with one
// slot per UTC month (U4): up when the month met the target, degraded under it, down when no
// probe answered, the percent beside it. Degraded counts as up: the site answered.
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (m: string) => MONTH.format(new Date(`${m}-01T00:00:00Z`));

function Uptime90({ ns }: { ns: string }) {
  const { feed } = useApp();
  const u = feed.uptime;
  const title = u ? `Uptime by month, ${u.days} days` : "Uptime by month, 90 days";
  const src = u ? `target ${pct(u.target, 1)}, five-minute probes` : "five-minute probes";
  if (u === undefined) return null;
  if (u === null) {
    return (
      <Panel title={title} src={src}>
        <St kind="nodata">No data</St> The daily counts could not be read.
      </Panel>
    );
  }
  const rows = u.sites.filter((s) => ns === "all" || s.namespace === ns);
  return (
    <Panel flush title={title} src={src}>
      {rows.length === 0 ? (
        <p className="faint">No probe counted yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Site</th>
                <th>Uptime by month</th>
                <th>Days counted</th>
                <th>Days under target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const share = s.probes > 0 ? s.up / s.probes : null;
                const slots: UptimeSlot[] = (s.months ?? []).map((m) => {
                  const r = m.probes > 0 ? m.up / m.probes : null;
                  const status = r === null ? "unknown" : m.up === 0 ? "down" : r >= u.target ? "up" : "degraded";
                  return { status, label: `${monthName(m.month)}: ${r === null ? "no probe" : `${pct(r, 2)} of ${m.probes} probes up, ${m.below} of ${m.days} days under target`}` };
                });
                const alt = `Uptime of ${s.namespace} by month: ${(s.months ?? []).map((m) => `${monthName(m.month)} ${m.probes ? pct(m.up / m.probes, 2) : "no data"}`).join(", ")}.`;
                return (
                  <tr key={s.namespace}>
                    <td>
                      <b>{s.namespace}</b>
                    </td>
                    <td>
                      {share === null ? (
                        <St kind="nodata">No data</St>
                      ) : (
                        <span className="cap-uptime-line">
                          <span className="cap-uptime-strip" dangerouslySetInnerHTML={{ __html: uptimeStrip({ slots, alt, inline: true, width: 120, height: 18 }) }} />
                          <span className="cap-uptime-pct">
                            <St kind={share >= u.target ? "ok" : "warn"}>{pct(share, 2)}</St>
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="num">{s.days}</td>
                    <td className="num">{s.below}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="cap-uptime-legend" aria-label="Key">
            <li><span className="cap-uptime-key" data-key="up" aria-hidden="true"></span>Met target</li>
            <li><span className="cap-uptime-key" data-key="degraded" aria-hidden="true"></span>Under target</li>
            <li><span className="cap-uptime-key" data-key="down" aria-hidden="true"></span>Down</li>
            <li><span className="cap-uptime-key" data-key="nodata" aria-hidden="true"></span>No data</li>
          </ul>
        </div>
      )}
    </Panel>
  );
}

// Capsid's own missing pages over 30 days (area 8, N4), from page_404_daily through GET
// /portal/api/not-found: each path with its hits and the hosts that linked to it, so a broken
// link names where it lives. Scanners' probes are counted, not listed. Each other site keeps
// its own table in its own database.
function NotFound() {
  const load = useAnswer<PortalNotFound>(["not-found"], fetchNotFound);
  const d = load.data;
  const title = `Missing pages, ${d?.days ?? 30} days`;
  const src = "Capsid's page_404_daily";
  if (load.loading) return <Panel title={title} src={src}><Spinner label="Reading the 404 counts" /></Panel>;
  if (load.error || !d || d.pages === null) {
    return (
      <Panel title={title} src={src}>
        <St kind="nodata">No data</St> The 404 counts could not be read: {load.error ?? d?.error ?? "no answer"}.
      </Panel>
    );
  }
  return (
    <Panel flush title={title} src={`${src}; ${d.probes ?? 0} scanner probes not listed`}>
      {d.pages.length === 0 ? (
        <p className="faint">No missing page was asked for.</p>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Path</th>
                <th>Hits</th>
                <th>Linked from</th>
              </tr>
            </thead>
            <tbody>
              {d.pages.map((p) => (
                <tr key={p.path}>
                  <td className="mono">{p.path}</td>
                  <td className="num">{p.hits}</td>
                  <td>{p.referrers.map((r) => `${r.host || "no referrer"} (${r.hits})`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
