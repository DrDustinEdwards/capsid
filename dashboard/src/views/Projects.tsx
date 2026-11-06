import { Spinner } from "capsomer/react/empty";
import { useApp } from "../app/ctx";
import { LIVE, fetchNamespaces, useAnswer } from "../lib/api";
import { agentState, driverOf } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import type { PortalNamespace, PortalNamespaces } from "../types";
import { Panel } from "capsomer/react/panel";
import "capsomer/button.css";
import { PageHead } from "./shared";

// PROJECTS (the Portal audit's new map, 2026-11-06; out of Settings): each project's driver,
// its jobs and the integrity of its latest truth report. A project paused after repeated
// failures (the queue's circuit breaker, src/job-breaker.ts) is reset one way, so the reset
// keeps its preview and confirm; Needs you offers the same Reset.

function Driver({ ns }: { ns: string }) {
  const { feed, now } = useApp();
  const d = driverOf(feed, ns);
  if (!d) return <St kind="nodata">No driver</St>;
  const st = agentState(d, now);
  return (
    <>
      <St kind={st.kind}>{st.label}</St>
      <div className="src">{d.revoked_at ? `revoked ${ago(ms(d.revoked_at), now)}` : d.last_seen ? `seen ${ago(ms(d.last_seen), now)}` : "never seen"}</div>
    </>
  );
}

// The latest truth report's integrity. Null is no report ever run, not an integrity of zero.
function Report({ n }: { n: PortalNamespace }) {
  const { now } = useApp();
  const rep = n.latest_report;
  if (!rep) return <St kind="nodata">No truth report</St>;
  return (
    <>
      {rep.integrity == null ? <St kind="nodata">No integrity figure</St> : <span className="num">{pct(rep.integrity, 0)}</span>}
      <div className="src">report {ago(ms(rep.generated), now)}</div>
    </>
  );
}

function Row({ n, onChanged }: { n: PortalNamespace; onChanged: () => void }) {
  const { confirm } = useApp();
  return (
    <tr data-row="">
      <td>
        <b className="mono">{n.namespace}</b>
        {n.breaker.open && (
          <>
            <div className="mt4">
              <St kind="crit">Paused after repeated failures</St>
            </div>
            <div className="src wrap">
              {n.breaker.failed} jobs failed since {n.breaker.since} UTC; it pauses at {n.breaker.threshold}. No job is handed out until it is reset.
            </div>
          </>
        )}
      </td>
      <td data-label="Driver">
        <Driver ns={n.namespace} />
      </td>
      <td data-label="Jobs" className="num nowrap">
        {n.jobs.queued} queued · {n.jobs.claimed} running
        <div className="src">
          {n.jobs.blocked} blocked · {n.jobs.done_today} done today
        </div>
      </td>
      <td data-label="Integrity">
        <Report n={n} />
      </td>
      <td className="ctl">
        {n.breaker.open && (
          <button type="button" className="btn" aria-label={`Reset ${n.namespace}`} onClick={() => confirm({ action: "reset_breaker", params: { namespace: n.namespace }, title: `Reset ${n.namespace} and hand out its jobs again`, onDone: onChanged })}>
            Reset
          </button>
        )}
      </td>
    </tr>
  );
}

function Roster() {
  const { now } = useApp();
  // The roster Needs you reads for its stops, so it follows the feed here too. The last
  // good read stays on screen while a new one runs or after one fails.
  const load = useAnswer<PortalNamespaces>([LIVE, "namespaces"], fetchNamespaces);
  const read = load.reread;
  const data = load.data;
  return (
    <>
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the projects: {load.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      <Panel
        flush
        title="Projects"
        id="projects"
        count={data?.namespaces.length}
        src={
          <>
            {data ? `read ${ago(ms(data.generated), now)} · ` : ""}
            <button type="button" className="btn" disabled={load.loading} onClick={read}>
              {load.loading ? "Reading..." : "Read again"}
            </button>
          </>
        }
      >
        {!data && load.loading ? (
          <div className="loading" role="status">
            <Spinner label="Reading the projects..." />
          </div>
        ) : data && data.namespaces.length ? (
          <div className="scroll-x reflow">
            <table className="list cards-below-1100 roster">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Driver</th>
                  <th>Jobs</th>
                  <th>Integrity</th>
                  <th>
                    <span className="sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.namespaces.map((n) => (
                  <Row key={n.namespace} n={n} onChanged={read} />
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="body faint">The roster has no projects.</div>
        ) : (
          <div className="body faint">No read yet.</div>
        )}
      </Panel>
    </>
  );
}

export function Projects() {
  return (
    <div className="page">
      <PageHead title="Projects" />
      <Roster />
    </div>
  );
}
