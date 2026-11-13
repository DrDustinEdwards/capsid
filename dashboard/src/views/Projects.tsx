import { Banner } from "capsomer/react/banner";
import { Spinner } from "capsomer/react/empty";
import { useApp } from "../app/ctx";
import { LIVE, fetchNamespaces } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { agentState, driverOf } from "../lib/derive";
import { ago, pct } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { St } from "../ui/icons";
import type { PortalNamespace, PortalNamespaces } from "../types";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { PageHead } from "./shared";
import { useEditor } from "capsomer/react/config-form";
import { ProjectForm } from "./ProjectConfig";

// PROJECTS (the Portal audit's new map, 2026-11-06; out of Settings): each project's driver,
// its jobs and the integrity of its latest truth report. A project paused after repeated
// failures (the queue's circuit breaker, src/job-breaker.ts) is reset one way, so the reset
// keeps its preview and confirm; Needs you offers the same Reset. Add project, and each row's
// Edit, open the form that registers, remaps or deletes a project (views/ProjectConfig.tsx).

function Driver({ ns }: { ns: string }) {
  const { feed, now } = useApp();
  const d = driverOf(feed, ns);
  if (!d) return <St kind="nodata">No driver</St>;
  const st = agentState(d, now);
  return (
    <>
      <St kind={st.kind}>{st.label}</St>
      <div className="src">
        {d.revoked_at
          ? `revoked ${ago(parse(d.revoked_at), now)}`
          : d.last_seen
            ? `seen ${ago(parse(d.last_seen), now)}`
            : "never seen"}
      </div>
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
      {rep.integrity == null ? (
        <St kind="nodata">No integrity figure</St>
      ) : (
        <span className="cap-num">{pct(rep.integrity, 0)}</span>
      )}
      <div className="src">report {ago(parse(rep.generated), now)}</div>
    </>
  );
}

function Row({
  n,
  onChanged,
  onEdit,
}: {
  n: PortalNamespace;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const { confirm } = useApp();
  return (
    <tr data-row="">
      <td>
        <b className="cap-mono">{n.namespace}</b>
        {n.breaker.open && (
          <>
            <div className="mt4">
              <St kind="crit">Paused after repeated failures</St>
            </div>
            <div className="src wrap">
              {n.breaker.failed} jobs failed since {n.breaker.since} UTC; it pauses at{" "}
              {n.breaker.threshold}. No job is handed out until it is reset.
            </div>
          </>
        )}
      </td>
      <td data-label="Repos">
        {n.repos.length ? (
          n.repos.map((r) => (
            <div key={r.repo}>
              <span className="cap-mono">{r.repo}</span>
              {r.label !== "primary" && (
                <span className="cap-text" data-tone="dim">
                  {" "}
                  {r.label}
                </span>
              )}
            </div>
          ))
        ) : (
          <St kind="nodata">None mapped</St>
        )}
      </td>
      <td data-label="Driver">
        <Driver ns={n.namespace} />
      </td>
      <td data-label="Jobs" className="cap-num nowrap">
        {n.jobs.queued} queued · {n.jobs.claimed} running
        <div className="src">
          {n.jobs.blocked} blocked · {n.jobs.done_today} done today
        </div>
      </td>
      <td data-label="Integrity">
        <Report n={n} />
      </td>
      <td className="ctl">
        <div className="toolbar col">
          <button
            type="button"
            className="cap-btn"
            aria-label={`Edit ${n.namespace}`}
            onClick={onEdit}
          >
            Edit
          </button>
          {n.breaker.open && (
            <button
              type="button"
              className="cap-btn"
              aria-label={`Reset ${n.namespace}`}
              onClick={() =>
                confirm({
                  action: "reset_breaker",
                  params: { namespace: n.namespace },
                  title: `Reset ${n.namespace} and hand out its jobs again`,
                  onDone: onChanged,
                })
              }
            >
              Reset
            </button>
          )}
        </div>
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
  const ed = useEditor<PortalNamespace>(read);
  return (
    <>
      <div className="toolbar">
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          onClick={ed.add}
          disabled={ed.editing?.kind === "add"}
        >
          Add project
        </button>
      </div>
      {ed.editing && <ProjectForm key={ed.formKey} editing={ed.editing} onClose={ed.close} />}
      {load.error && (
        <Banner tone="crit">
          Could not read the projects: {load.error}
          {data ? `. Showing the read from ${ago(parse(data.generated), now)}.` : ""}
        </Banner>
      )}
      <Panel
        flush
        title="Projects"
        id="projects"
        count={data?.namespaces.length}
        src={
          <ReadAgain
            at={data ? parse(data.generated) : undefined}
            now={now}
            reading={load.loading}
            onRead={read}
          />
        }
      >
        {!data && load.loading ? (
          <div className="loading" role="status">
            <Spinner label="Reading the projects..." />
          </div>
        ) : data && data.namespaces.length ? (
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table roster">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Repos</th>
                  <th>Driver</th>
                  <th>Jobs</th>
                  <th>Integrity</th>
                  <th>
                    <span className="cap-sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.namespaces.map((n) => (
                  <Row
                    key={n.namespace}
                    n={n}
                    onChanged={read}
                    onEdit={() => ed.edit(n, n.namespace)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="cap-text body" data-tone="dim">
            The roster has no projects.
          </div>
        ) : (
          <div className="cap-text body" data-tone="dim">
            No read yet.
          </div>
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
