import { Alert, Banner } from "capsomer/react/banner";
import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { useApp } from "../app/ctx";
import { fetchConvergence } from "../lib/api";
import { useAnswer, type Load } from "capsomer/react/data";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { ConvergenceCheck, ConvergenceSite, PortalConvergence } from "../types";
import { Status } from "capsomer/react/status";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

// The convergence view in Sites (job_09e5f6cbf782): for each site that opted into Capsid
// calling its operator API, GET /portal/api/convergence reads, live, what the site's
// sync_status and health route say, the repair each check maps to, and its Worker's
// secrets by name. "Run" is the site_repair control: the same preview and perform as
// every control, the allowlist enforced in the Worker. Nothing on this panel is a value
// of a secret; the Worker never sends one.

function useConvergence(): {
  load: Load<PortalConvergence>;
  reread: () => void;
} {
  const load = useAnswer(["convergence"], fetchConvergence);
  return { load, reread: load.reread };
}

// One site's Sync and repairs tab. A site that has not opted in says so.
export function Convergence({ ns }: { ns: string }) {
  const { load, reread } = useConvergence();
  const data = load.data;
  const sites = data ? data.sites.filter((s) => s.namespace === ns) : [];
  if (data && sites.length === 0) {
    return (
      <Empty kind="nothing-yet" title="This site has not opted in.">
        Capsid calls a site's operator API only when the site's row names one (its operator field).
        Until then there is no sync status to read and no repair to run.
      </Empty>
    );
  }
  if (!data) {
    return (
      <Panel flush title="Site sync" id="convergence" section="Site sync">
        {load.error ? (
          <Banner tone="crit">Could not read site sync: {load.error}</Banner>
        ) : (
          <div className="loading" role="status">
            <Spinner label="Reading each site's operator API..." />
          </div>
        )}
      </Panel>
    );
  }
  return (
    <>
      {load.error && (
        <Banner tone="crit">
          Could not read site sync again: {load.error}. Showing the read from{" "}
          {data.generated.slice(11, 16)} UTC.
        </Banner>
      )}
      {sites.map((s) => (
        <SitePanel key={s.namespace} site={s} loading={load.loading} reread={reread} />
      ))}
    </>
  );
}

function SitePanel({
  site,
  loading,
  reread,
}: {
  site: ConvergenceSite;
  loading: boolean;
  reread: () => void;
}) {
  const { now, confirm } = useApp();
  const run = (tool: string) =>
    confirm({
      action: "site_repair",
      params: { namespace: site.namespace, tool },
      title: `Run ${tool} on ${site.name}`,
      onDone: reread,
    });
  const op = site.operator;
  const failing = site.health?.checks.filter((c) => !c.ok).length ?? 0;
  return (
    <Panel
      flush
      title="Operator API"
      id={`convergence-${site.namespace}`}
      section="Operator API"
      src={<ReadAgain at={parse(site.read_at)} now={now} reading={loading} onRead={reread} />}
    >
      <div className="body cap-stack" data-gap="4" data-convergence={site.namespace}>
        {site.problem && <Alert tone="warn">{site.problem}</Alert>}
        {op && !op.secret_set && (
          <Alert tone="warn">
            The Capsid Worker secret <span className="cap-mono">{op.auth_var}</span> is not set, so
            Capsid calls nothing on this site. The seat sets it with wrangler secret put.
          </Alert>
        )}
        {op && (
          <dl className="cap-detail-record">
            <dt>Operator API</dt>
            <dd className="cap-mono">
              {site.origin}
              {op.path}
            </dd>
            <dt>Health</dt>
            <dd>
              {!site.health || site.health.error ? (
                <Status tone="nodata">{site.health?.error ?? "Not read"}</Status>
              ) : site.health.ok ? (
                <Status tone="ok">Converged</Status>
              ) : (
                <Status tone="warn">{`${failing} ${failing === 1 ? "check" : "checks"} failing (HTTP ${site.health.http_status ?? "?"})`}</Status>
              )}
            </dd>
            {op.weekly.length > 0 && (
              <>
                <dt>Weekly</dt>
                <dd className="cap-cluster" data-gap="3">
                  {op.weekly.map((tool) => (
                    <span key={tool}>
                      <span className="cap-mono">{tool}</span>{" "}
                      <button
                        type="button"
                        className="cap-btn"
                        disabled={!op.secret_set}
                        onClick={() => run(tool)}
                      >
                        Run now
                      </button>
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        )}
      </div>
      {site.health && site.health.checks.length > 0 && (
        <Checks checks={site.health.checks} canRun={!!op?.secret_set} run={run} />
      )}
      {site.status && (
        <div className="body cap-stack" data-gap="4">
          <h3 className="conv-h">Operator sync_status</h3>
          {site.status.error ? (
            <Alert tone="neutral">
              <Status tone="nodata">Not read</Status> {site.status.error}
            </Alert>
          ) : (
            <dl className="cap-detail-record">
              {site.status.fields.map((f) => (
                <FieldRow key={f.key} k={f.key} v={f.value} />
              ))}
            </dl>
          )}
        </div>
      )}
      {site.recent.length > 0 && (
        <div className="body cap-stack" data-gap="4">
          <h3 className="conv-h">Recent repairs</h3>
          <ul className="plain">
            {site.recent.map((r, i) => (
              <li key={`${r.at}|${i}`}>
                <span className="cap-mono">{r.tool}</span>{" "}
                {r.converged === true ? (
                  <Status tone="ok">converged</Status>
                ) : r.converged === false ? (
                  <Status tone="warn">did not converge</Status>
                ) : (
                  <Status tone="nodata">{r.error ? "failed" : "no verdict"}</Status>
                )}{" "}
                <span className="cap-text" data-tone="dim">
                  {ago(parse(r.at), now)} by {r.actor}
                  {r.via ? ` (${r.via})` : ""}
                  {r.error ? `: ${r.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="cap-mono">{k}</dt>
      <dd className="cap-num">{v}</dd>
    </>
  );
}

function Checks({
  checks,
  canRun,
  run,
}: {
  checks: ConvergenceCheck[];
  canRun: boolean;
  run: (tool: string) => void;
}) {
  const sorted = [...checks].sort((a, b) => Number(a.ok) - Number(b.ok));
  return (
    <div className="cap-table-wrap">
      <table className="cap-table">
        <thead>
          <tr>
            <th>Check</th>
            <th>State</th>
            <th className="cap-num">Present</th>
            <th>Repair</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.name} data-check={c.name}>
              <td>
                <b className="cap-mono">{c.name}</b>
                {c.detail && (
                  <div className="cap-text" data-tone="dim">
                    {c.detail}
                  </div>
                )}
              </td>
              <td>{c.ok ? <Status tone="ok">ok</Status> : <Status tone="warn">drifted</Status>}</td>
              <td className="cap-num">
                {c.expected === null ? "" : `${c.present ?? "?"} of ${c.expected}`}
              </td>
              <td>
                {!c.repair ? (
                  <span className="cap-text" data-tone="dim">
                    none Capsid may run
                  </span>
                ) : c.repair_refusal ? (
                  <span className="cap-text" data-tone="dim" title={c.repair_refusal}>
                    <span className="cap-mono">{c.repair}</span> not allowed
                  </span>
                ) : (
                  <span className="cap-cluster" data-gap="3">
                    <span className="cap-mono">{c.repair}</span>
                    <button
                      type="button"
                      className="cap-btn"
                      disabled={!canRun}
                      onClick={() => run(c.repair as string)}
                    >
                      Run
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The site's Worker secrets by name, set or not, against what its configuration names: on
// the site's Setup tab, from the same read.
export function SiteSecrets({ ns }: { ns: string }) {
  const { load } = useConvergence();
  const site = load.data?.sites.find((s) => s.namespace === ns);
  if (!site?.secrets) return null;
  return (
    <Panel flush title="Worker secrets" id="secrets" section="Worker secrets">
      <Secrets secrets={site.secrets} />
    </Panel>
  );
}

function Secrets({ secrets }: { secrets: NonNullable<ConvergenceSite["secrets"]> }) {
  return (
    <div className="body cap-stack" data-gap="4">
      {secrets.script ? (
        <p className="cap-text cap-mono" data-tone="dim">
          {secrets.script}
        </p>
      ) : null}
      {secrets.state !== "ok" ? (
        <Alert tone="neutral">
          <Status tone="nodata">Not read</Status> {secrets.reason}
        </Alert>
      ) : secrets.rows.length === 0 ? (
        <Empty kind="all-clear" title="The Worker has no secrets." />
      ) : (
        <ul className="plain">
          {secrets.rows.map((r) => (
            <li key={r.name}>
              <span className="cap-mono">{r.name}</span>{" "}
              {r.set ? <Status tone="ok">set</Status> : <Status tone="crit">not set</Status>}
              {!r.expected && (
                <span className="cap-text" data-tone="dim">
                  {" "}
                  not named in the site's configuration
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="cap-text" data-tone="dim">
        Names only, from Cloudflare's secrets list on the watcher's pass
        {secrets.read_at ? ` (${secrets.read_at.slice(0, 16).replace("T", " ")} UTC)` : ""}. A value
        is never read.
      </div>
    </div>
  );
}
