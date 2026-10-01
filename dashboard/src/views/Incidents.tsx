import { useApp } from "../app/ctx";
import { incidents, passStale, TASK_OUTCOME } from "../lib/derive";
import { ago, age, ms } from "../lib/format";
import type { OpsTask } from "../types";
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
      <ScheduledTasks />
    </div>
  );
}

const FLAG: Record<NonNullable<OpsTask["flag"]>, string> = {
  failing: "Failing",
  quiet: "Not running",
  never: "No run yet",
};

// The run ledger (src/task-runs.ts): every scheduled task, its newest run, and the
// runs before it. A task is flagged when its newest run threw or was refused, or when
// a periodic task has had no run in twice its period.
function ScheduledTasks() {
  const { feed, now } = useApp();
  const s = feed.scheduled;
  return (
    <Panel title="Scheduled tasks" src="run ledger" id="scheduled">
      {s.error !== null ? (
        <div className="body">
          <div className="callout">
            <St kind="nodata">No data</St> The run ledger could not be read: {s.error}
          </div>
        </div>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Task</th>
                <th>State</th>
                <th>Last run</th>
                <th>What it did</th>
              </tr>
            </thead>
            <tbody>
              {s.tasks.map((t) => {
                const last = t.recent[0];
                const earlier = t.recent.slice(1);
                return (
                  <tr key={t.id} data-task={t.id}>
                    <td>
                      {t.label}
                      <div className="faint">{t.period_ms == null ? "runs with its work" : `every ${age(now - t.period_ms, now)}`}</div>
                    </td>
                    <td>
                      {t.flag === "failing" || t.flag === "quiet" ? (
                        <St kind={t.id === "backup" ? "crit" : "warn"}>{FLAG[t.flag]}</St>
                      ) : t.flag === "never" ? (
                        <St kind="nodata">{FLAG.never}</St>
                      ) : (
                        <St kind="ok">Running</St>
                      )}
                    </td>
                    <td className="num">
                      {last ? (
                        <>
                          <St kind={TASK_OUTCOME[last.outcome].kind}>{TASK_OUTCOME[last.outcome].label}</St> {ago(ms(last.finished_at), now)}
                        </>
                      ) : (
                        <span className="faint">none recorded</span>
                      )}
                    </td>
                    <td className="muted">
                      {last?.reason}
                      {earlier.length > 0 && (
                        <details>
                          <summary className="faint">{earlier.length} earlier</summary>
                          <ul className="plain">
                            {earlier.map((r) => (
                              <li key={r.started_at}>
                                <St kind={TASK_OUTCOME[r.outcome].kind}>{TASK_OUTCOME[r.outcome].label}</St> {ago(ms(r.finished_at), now)}: {r.reason}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
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
