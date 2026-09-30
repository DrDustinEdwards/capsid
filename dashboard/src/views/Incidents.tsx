import { useApp } from "../app/ctx";
import { incidents, passStale } from "../lib/derive";
import { ago, ms, utc } from "../lib/format";
import { St } from "../ui/icons";
import { IncidentFeed, NoSnapshot, NsChips, PageHead, Panel } from "./shared";

export function Incidents() {
  const { feed, now, filters } = useApp();
  const snap = feed.snapshot;
  return (
    <div className="page">
      <PageHead title="Incidents">Watcher findings, open first. Each has a fingerprint, is posted once, and clears on its own when the condition goes away.</PageHead>
      <NsChips list={incidents(feed).map((x) => x.ns)} />
      <div className="grid2">
        <Panel title="Findings" src="jobs posted by agent:watcher">
          <IncidentFeed ns={filters.ns} />
        </Panel>
        <Panel title="Last watcher pass" src={snap ? utc(ms(snap.pass_at)) : "none yet"}>
          {snap ? (
            <>
              <div className="body">
                <dl className="kv">
                  <dt>Finished</dt>
                  <dd>
                    {ago(ms(snap.pass_at), now)} {passStale(snap, now) && <St kind="warn">stale</St>}
                  </dd>
                  <dt>Cadence</dt>
                  <dd className="num">every {snap.cadence_min} min</dd>
                  <dt>Duration</dt>
                  <dd className="num">{(snap.pass_ms / 1000).toFixed(1)}s</dd>
                  <dt>Site map</dt>
                  <dd>
                    {!snap.site_map ? (
                      <St kind="nodata">Not read</St>
                    ) : snap.site_map.unmapped.length || snap.site_map.unknown.length ? (
                      <span className="mono">
                        {snap.site_map.unmapped.length ? `unmapped: ${snap.site_map.unmapped.join(", ")}` : ""}
                        {snap.site_map.unmapped.length && snap.site_map.unknown.length ? " · " : ""}
                        {snap.site_map.unknown.length ? `unknown: ${snap.site_map.unknown.join(", ")}` : ""}
                      </span>
                    ) : (
                      <St kind="ok">No drift</St>
                    )}
                  </dd>
                </dl>
              </div>
              <div className="scroll-x">
                <table className="list">
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th>Result</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snap.checks.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.id}</td>
                        <td>{c.state === "could-not-run" ? <St kind="nodata">Could not run</St> : c.state === "clear" ? <St kind="ok">Clear</St> : <St kind="warn">Finding open</St>}</td>
                        <td className="muted">{c.findings.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="body">
              <NoSnapshot />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
