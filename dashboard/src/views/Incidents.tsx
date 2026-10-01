import { useApp } from "../app/ctx";
import { incidents, passStale } from "../lib/derive";
import { ago, ms } from "../lib/format";
import { St } from "../ui/icons";
import { When } from "../ui/When";
import { FilterEmpty, IncidentFeed, NoSnapshot, NsChips, PageHead, Panel, useNsFilter } from "./shared";

export function Incidents() {
  const { feed, now } = useApp();
  const [ns, setNs] = useNsFilter();
  const snap = feed.snapshot;
  const all = incidents(feed);
  const emptied = ns !== "all" && all.length > 0 && !all.some((x) => x.ns === ns);
  return (
    <div className="page">
      <PageHead title="Incidents" />
      <NsChips list={all.map((x) => x.ns)} />
      <div className="grid2">
        <Panel title="Findings" src="jobs posted by agent:watcher">
          {emptied ? <FilterEmpty onShowAll={() => setNs("all")}>No finding in the namespace {ns}.</FilterEmpty> : <IncidentFeed ns={ns} />}
        </Panel>
        <Panel title="Last watcher pass" src={snap ? <When t={ms(snap.pass_at)} /> : "none yet"}>
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
