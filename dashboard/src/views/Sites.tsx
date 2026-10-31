import { useApp } from "../app/ctx";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
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
// counts (ops_uptime_daily). Degraded counts as up: the site answered.
function Uptime90({ ns }: { ns: string }) {
  const { feed } = useApp();
  const u = feed.uptime;
  const title = u ? `Uptime, ${u.days} days` : "Uptime, 90 days";
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
                <th>Uptime</th>
                <th>Days counted</th>
                <th>Days under target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const share = s.probes > 0 ? s.up / s.probes : null;
                const met = share !== null && share >= u.target;
                return (
                  <tr key={s.namespace}>
                    <td>
                      <b>{s.namespace}</b>
                    </td>
                    <td className="num">{share === null ? <St kind="nodata">No data</St> : <St kind={met ? "ok" : "warn"}>{pct(share, 2)}</St>}</td>
                    <td className="num">{s.days}</td>
                    <td className="num">{s.below}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
