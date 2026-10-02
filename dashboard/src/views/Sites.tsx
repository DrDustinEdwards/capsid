import { useApp } from "../app/ctx";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { ago, ms } from "../lib/format";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
import { FilterEmpty, FleetTable, NoSnapshot, NsChips, PageHead, useNsFilter } from "./shared";

export function Sites() {
  const { feed, now } = useApp();
  const [ns, setNs] = useNsFilter();
  const snap = feed.snapshot;
  const head = (
    <PageHead title="Sites" />
  );
  if (!snap) {
    return (
      <div className="page">
        {head}
        <NoSnapshot />
      </div>
    );
  }
  const list = snap.sites.filter((s) => ns === "all" || s.namespace === ns);
  const emptied = !list.length && snap.sites.length > 0;
  return (
    <div className="page">
      {head}
      <NsChips list={snap.sites.map((s) => s.namespace)} />
      <Panel flush title="Fleet" src={`watcher pass ${ago(ms(snap.pass_at), now)}`}>
        {emptied ? <FilterEmpty onShowAll={() => setNs("all")}>No site in the namespace {ns}.</FilterEmpty> : <FleetTable sites={list} />}
      </Panel>
      <Panel flush title="Health contract coverage" src="GET /health returning {status, sha}">
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
    </div>
  );
}
