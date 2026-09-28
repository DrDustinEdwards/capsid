import { useApp } from "../app/ctx";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { ago, ms } from "../lib/format";
import { St } from "../ui/icons";
import { FleetTable, NoSnapshot, NsChips, PageHead, Panel } from "./shared";

export function Sites() {
  const { feed, now, filters } = useApp();
  const snap = feed.snapshot;
  const head = (
    <PageHead title="Sites">One row per deployed site. Health comes from each site's own route where it has one; a root 200 is shown as liveness, not health.</PageHead>
  );
  if (!snap) {
    return (
      <div className="page">
        {head}
        <NoSnapshot />
      </div>
    );
  }
  const list = snap.sites.filter((s) => filters.ns === "all" || s.namespace === filters.ns);
  return (
    <div className="page">
      {head}
      <NsChips list={snap.sites.map((s) => s.namespace)} />
      <Panel title="Fleet" src={`watcher pass ${ago(ms(snap.pass_at), now)}`}>
        <FleetTable sites={list} />
      </Panel>
      <Panel title="Health contract coverage" src="GET /health returning {status, sha}">
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
                    <td className="mono">
                      {s.health_path ? (
                        <>
                          {s.health_path} {s.state === "degraded" && s.http_status != null && <St kind="warn">{String(s.http_status)}</St>}
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
