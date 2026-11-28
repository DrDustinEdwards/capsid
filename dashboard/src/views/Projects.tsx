import { Banner } from "capsomer/react/banner";
import { Spinner } from "capsomer/react/skeleton";
import { useApp } from "../app/ctx";
import { LIVE, fetchNamespaces } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { KIND_STATUS } from "../lib/derive";
import { agentState, driverOf } from "../lib/agents";
import { ago, pct } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import type { PortalNamespace, PortalNamespaces } from "../types";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { PageHead } from "./shared";
import { useEditor } from "capsomer/react/config-form";
import { Suspense, lazy } from "react";

const ProjectForm = lazy(() => import("./ProjectConfig").then((m) => ({ default: m.ProjectForm })));

function Driver({ ns }: { ns: string }) {
  const { feed, now } = useApp();
  const d = driverOf(feed, ns);
  if (!d) return <Status tone="nodata">No driver</Status>;
  const st = agentState(d, now);
  return (
    <>
      <Status {...KIND_STATUS[st.kind]}>{st.label}</Status>
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

function Report({ n }: { n: PortalNamespace }) {
  const { now } = useApp();
  const rep = n.latest_report;
  if (!rep) return <Status tone="nodata">No truth report</Status>;
  return (
    <>
      {rep.integrity == null ? (
        <Status tone="nodata">No integrity figure</Status>
      ) : (
        <span className="cap-num">{pct(rep.integrity, 0)}</span>
      )}
      <div className="src">report {ago(parse(rep.generated), now)}</div>
    </>
  );
}

function Row({ n, onEdit }: { n: PortalNamespace; onEdit: () => void }) {
  return (
    <tr data-row="">
      <td>
        <b className="cap-mono">{n.namespace}</b>
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
          <Status tone="nodata">None mapped</Status>
        )}
      </td>
      <td data-label="Driver">
        <Driver ns={n.namespace} />
      </td>
      <td data-label="Integrity">
        <Report n={n} />
      </td>
      <td className="ctl">
        <div className="cap-stack" data-gap="3" data-align="end">
          <button
            type="button"
            className="cap-btn"
            aria-label={`Edit ${n.namespace}`}
            onClick={onEdit}
          >
            Edit
          </button>
        </div>
      </td>
    </tr>
  );
}

function Roster() {
  const { now } = useApp();
  const load = useAnswer<PortalNamespaces>([LIVE, "namespaces"], fetchNamespaces);
  const read = load.reread;
  const data = load.data;
  const ed = useEditor<PortalNamespace>(read);
  return (
    <>
      <div className="cap-cluster" data-gap="3">
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
      {ed.editing && (
        <Suspense fallback={<Spinner />}>
          <ProjectForm key={ed.formKey} editing={ed.editing} onClose={ed.close} />
        </Suspense>
      )}
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
          <Spinner layout="page" label="Reading the projects..." />
        ) : data && data.namespaces.length ? (
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table roster">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Repos</th>
                  <th>Driver</th>
                  <th>Integrity</th>
                  <th>
                    <span className="cap-sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.namespaces.map((n) => (
                  <Row key={n.namespace} n={n} onEdit={() => ed.edit(n, n.namespace)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="cap-text body" data-tone="dim">
            The roster has no projects.
          </div>
        ) : null}
      </Panel>
    </>
  );
}

export function Projects() {
  return (
    <div className="cap-admin-page">
      <PageHead title="Projects" />
      <Roster />
    </div>
  );
}
