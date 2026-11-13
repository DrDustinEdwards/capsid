import { Alert } from "capsomer/react/banner";
import { useApp } from "../app/ctx";
import { KIND_STATUS, incidents, passStale, TASK_OUTCOME } from "../lib/derive";
import { ago, age } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { OpsTask } from "../types";
import { Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { Panel } from "capsomer/react/panel";
import { FilterEmpty, IncidentFeed, NoSnapshot, NsChips, useNsFilter } from "./shared";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

// Health's Problems tab: the watcher's findings and its last pass.
export function Incidents() {
  const { feed, now } = useApp();
  const [ns, setNs] = useNsFilter();
  const snap = feed.snapshot;
  const all = incidents(feed);
  const emptied = ns !== "all" && all.length > 0 && !all.some((x) => x.ns === ns);
  return (
    <div className="cap-stack">
      <NsChips list={all.map((x) => x.ns)} />
      <div className="cap-panes" data-even data-gap="5">
        <Panel flush title="Findings" src="jobs posted by agent:watcher">
          {emptied ? (
            <FilterEmpty onShowAll={() => setNs("all")}>
              No finding in the project {ns}.
            </FilterEmpty>
          ) : (
            <IncidentFeed ns={ns} />
          )}
        </Panel>
        <Panel
          flush
          title="Last watcher pass"
          src={snap ? <Time at={snap.pass_at} format="exact" /> : "none yet"}
        >
          {snap ? (
            <>
              <div className="body">
                <dl className="cap-detail-record">
                  <dt>Finished</dt>
                  <dd>
                    {ago(parse(snap.pass_at), now)}{" "}
                    {passStale(snap, now) && <Status tone="warn">stale</Status>}
                  </dd>
                  <dt>Cadence</dt>
                  <dd className="cap-num">every {snap.cadence_min} min</dd>
                  <dt>Duration</dt>
                  <dd className="cap-num">{(snap.pass_ms / 1000).toFixed(1)}s</dd>
                  <dt>Site map</dt>
                  <dd>
                    {!snap.site_map ? (
                      <Status tone="nodata">Not read</Status>
                    ) : snap.site_map.unmapped.length || snap.site_map.unknown.length ? (
                      <span className="cap-mono">
                        {snap.site_map.unmapped.length
                          ? `unmapped: ${snap.site_map.unmapped.join(", ")}`
                          : ""}
                        {snap.site_map.unmapped.length && snap.site_map.unknown.length ? " · " : ""}
                        {snap.site_map.unknown.length
                          ? `unknown: ${snap.site_map.unknown.join(", ")}`
                          : ""}
                      </span>
                    ) : (
                      <Status tone="ok">No drift</Status>
                    )}
                  </dd>
                </dl>
              </div>
              <div className="cap-table-wrap">
                <table className="cap-table">
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
                        <td className="cap-mono">{c.id}</td>
                        <td>
                          {c.state === "could-not-run" ? (
                            <Status tone="nodata">Could not run</Status>
                          ) : c.state === "clear" ? (
                            <Status tone="ok">Clear</Status>
                          ) : (
                            <Status tone="warn">Finding open</Status>
                          )}
                        </td>
                        <td className="cap-muted">{c.findings.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <NoSnapshot />
          )}
        </Panel>
      </div>
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
export function ScheduledTasks() {
  const { feed, now } = useApp();
  const s = feed.scheduled;
  return (
    <Panel flush title="Scheduled tasks" src="run ledger" id="scheduled">
      {s.error !== null ? (
        <div className="body">
          <Alert tone="neutral">
            <Status tone="nodata">No data</Status> The run ledger could not be read: {s.error}
          </Alert>
        </div>
      ) : (
        <div className="cap-table-wrap">
          <table className="cap-table">
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
                      <div className="cap-text" data-tone="dim">
                        {t.period_ms == null
                          ? "runs with its work"
                          : `every ${age(now - t.period_ms, now)}`}
                      </div>
                    </td>
                    <td>
                      {t.flag === "failing" || t.flag === "quiet" ? (
                        <Status tone={t.id === "backup" ? "crit" : "warn"}>{FLAG[t.flag]}</Status>
                      ) : t.flag === "never" ? (
                        <Status tone="nodata">{FLAG.never}</Status>
                      ) : (
                        <Status tone="ok">Running</Status>
                      )}
                    </td>
                    <td className="cap-num">
                      {last ? (
                        <>
                          <Status {...KIND_STATUS[TASK_OUTCOME[last.outcome].kind]}>
                            {TASK_OUTCOME[last.outcome].label}
                          </Status>{" "}
                          {ago(parse(last.finished_at), now)}
                        </>
                      ) : (
                        <span className="cap-text" data-tone="dim">
                          none recorded
                        </span>
                      )}
                    </td>
                    <td className="cap-muted">
                      {last?.reason}
                      {earlier.length > 0 && (
                        <details>
                          <summary className="cap-text" data-tone="dim">
                            {earlier.length} earlier
                          </summary>
                          <ul className="plain">
                            {earlier.map((r) => (
                              <li key={r.started_at}>
                                <Status {...KIND_STATUS[TASK_OUTCOME[r.outcome].kind]}>
                                  {TASK_OUTCOME[r.outcome].label}
                                </Status>{" "}
                                {ago(parse(r.finished_at), now)}: {r.reason}
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
