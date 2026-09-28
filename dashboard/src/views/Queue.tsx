import { useApp } from "../app/ctx";
import { ago, ms } from "../lib/format";
import { St } from "../ui/icons";
import { NsChips, PageHead, Panel, QueueRows } from "./shared";

export function SeatStart() {
  const { feed, now } = useApp();
  const s = feed.live.seat_start;
  return (
    <dl className="kv">
      <dt>Switch</dt>
      <dd>{s.enabled ? <St kind="ok">On</St> : <St kind="nodata">Off</St>}</dd>
      <dt>In flight</dt>
      <dd className="mono">
        {s.in_flight} of {s.max_sessions}
      </dd>
      <dt>Last 7 days</dt>
      <dd>
        {s.recent.length
          ? s.recent.map((r) => (
              <div key={`${r.job_id}-${r.at}`}>
                <span className="mono">{r.job_id}</span>{" "}
                <span className="faint">
                  {r.namespace ?? "no namespace"} · {ago(ms(r.at), now)} ·{" "}
                </span>
                {r.run_url ? (
                  <a href={r.run_url} target="_blank" rel="noopener noreferrer">
                    run {r.run_id ?? ""}
                  </a>
                ) : (
                  <span className="faint">runner never presented its token</span>
                )}
              </div>
            ))
          : <span className="faint">No sessions started.</span>}
      </dd>
    </dl>
  );
}

export function Queue() {
  const { feed, filters, setFilters } = useApp();
  const all = feed.live.jobs;
  const q = filters.q.trim().toLowerCase();
  const jobs = all.filter((j) => (filters.ns === "all" || j.namespace === filters.ns) && (!q || `${j.title} ${j.id} ${j.waits_on ?? ""} ${j.command ?? ""}`.toLowerCase().includes(q)));
  const nss = [...new Set(all.map((j) => j.namespace))];
  return (
    <div className="page">
      <PageHead title="Queue">Every namespace, grouped by what it needs. A blocked job shows what it waits on; open it for the exact command and the resume call.</PageHead>
      <div className="toolbar">
        <NsChips list={nss} />
        <input className="search" id="qsearch" type="search" placeholder="Filter jobs (f)" value={filters.q} aria-label="Filter jobs" onChange={(e) => setFilters({ q: e.target.value })} />
      </div>
      <div className="grid2">
        <Panel title="Jobs" src="live · D1 jobs, read on each refresh">
          <QueueRows jobs={jobs} />
        </Panel>
        <Panel title="By namespace">
          <div className="scroll-x">
            <table className="list">
              <tbody>
                {nss.map((ns) => {
                  const js = all.filter((j) => j.namespace === ns);
                  const b = js.filter((j) => j.status === "blocked").length;
                  const r = js.filter((j) => j.status === "claimed").length;
                  const qd = js.filter((j) => j.status === "queued").length;
                  const tot = Math.max(1, b + r + qd);
                  return (
                    <tr key={ns}>
                      <td className="mono">{ns}</td>
                      <td className="w50">
                        <div className="stack" role="img" aria-label={`${ns}: ${b} blocked, ${r} running, ${qd} queued`}>
                          <i className="b" style={{ width: `${(b / tot) * 100}%` }} />
                          <i className="r" style={{ width: `${(r / tot) * 100}%` }} />
                          <i className="q" style={{ width: `${(qd / tot) * 100}%` }} />
                        </div>
                      </td>
                      <td className="mono">{b} blocked</td>
                      <td className="mono">{r} running</td>
                      <td className="mono">{qd} queued</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="body">
            <p className="section-title">Seat-started sessions</p>
            <SeatStart />
          </div>
        </Panel>
      </div>
    </div>
  );
}
