import { useCallback, useEffect, useState } from "react";
import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { fetchConvergence } from "../lib/api";
import { ago, ms } from "../lib/format";
import type { ConvergenceCheck, ConvergenceSite, PortalConvergence } from "../types";
import { St } from "../ui/icons";

// The convergence view in Sites (job_09e5f6cbf782): for each site that opted into Capsid
// calling its operator API, GET /portal/api/convergence reads, live, what the site's
// sync_status and health route say, the repair each check maps to, and its Worker's
// secrets by name. "Run" is the site_repair control: the same preview and perform as
// every control, the allowlist enforced in the Worker. Nothing on this panel is a value
// of a secret; the Worker never sends one.

type Load = { data: PortalConvergence | null; loading: boolean; error: string | null };

export function useConvergence(): { load: Load; reread: () => void } {
  const { signOut } = useApp();
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoad((l) => ({ ...l, loading: true }));
    void fetchConvergence().then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setLoad({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      const message = r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message;
      setLoad((l) => ({ ...l, loading: false, error: message }));
    });
    return () => {
      alive = false;
    };
  }, [tick, signOut]);
  return { load, reread: useCallback(() => setTick((t) => t + 1), []) };
}

export function Convergence({ ns }: { ns: string }) {
  const { load, reread } = useConvergence();
  const data = load.data;
  const sites = data ? data.sites.filter((s) => ns === "all" || s.namespace === ns) : [];
  if (data && data.sites.length === 0) return null;
  if (!data) {
    return (
      <Panel flush title="Convergence" id="convergence" section="Convergence">
        {load.error ? (
          <div className="callout crit" role="alert">
            Could not read the convergence view: {load.error}
          </div>
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
        <div className="callout crit" role="alert">
          Could not read the convergence view again: {load.error}. Showing the read from {data.generated.slice(11, 16)} UTC.
        </div>
      )}
      {sites.map((s) => (
        <SitePanel key={s.namespace} site={s} loading={load.loading} reread={reread} />
      ))}
    </>
  );
}

function SitePanel({ site, loading, reread }: { site: ConvergenceSite; loading: boolean; reread: () => void }) {
  const { now, confirm } = useApp();
  const run = (tool: string) => confirm({ action: "site_repair", params: { namespace: site.namespace, tool }, title: `Run ${tool} on ${site.name}`, onDone: reread });
  const op = site.operator;
  const failing = site.health?.checks.filter((c) => !c.ok).length ?? 0;
  return (
    <Panel
      flush
      title={`Convergence: ${site.name}`}
      id={`convergence-${site.namespace}`}
      section={`Convergence ${site.name}`}
      src={
        <>
          {`read ${ago(ms(site.read_at), now)} · `}
          <button type="button" className="btn" disabled={loading} onClick={reread}>
            {loading ? "Reading..." : "Read again"}
          </button>
        </>
      }
    >
      <div className="body stack-gap" data-convergence={site.namespace}>
        {site.problem && <div className="callout warn">{site.problem}</div>}
        {op && !op.secret_set && (
          <div className="callout warn">
            The Capsid Worker secret <span className="mono">{op.auth_var}</span> is not set, so Capsid calls nothing on this site. The seat sets it with wrangler secret put.
          </div>
        )}
        {op && (
          <dl className="kv">
            <dt>Operator API</dt>
            <dd className="mono">
              {site.origin}
              {op.path}
            </dd>
            <dt>Health</dt>
            <dd>
              {!site.health || site.health.error ? (
                <St kind="nodata">{site.health?.error ?? "Not read"}</St>
              ) : site.health.ok ? (
                <St kind="ok">Converged</St>
              ) : (
                <St kind="warn">{`${failing} ${failing === 1 ? "check" : "checks"} failing (HTTP ${site.health.http_status ?? "?"})`}</St>
              )}
            </dd>
            {op.weekly.length > 0 && (
              <>
                <dt>Weekly</dt>
                <dd className="row-gap">
                  {op.weekly.map((tool) => (
                    <span key={tool}>
                      <span className="mono">{tool}</span>{" "}
                      <button type="button" className="btn" disabled={!op.secret_set} onClick={() => run(tool)}>
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
      {site.health && site.health.checks.length > 0 && <Checks checks={site.health.checks} canRun={!!op?.secret_set} run={run} />}
      {site.status && (
        <div className="body stack-gap">
          <h3 className="conv-h">Operator sync_status</h3>
          {site.status.error ? (
            <div className="callout">
              <St kind="nodata">Not read</St> {site.status.error}
            </div>
          ) : (
            <dl className="kv">
              {site.status.fields.map((f) => (
                <FieldRow key={f.key} k={f.key} v={f.value} />
              ))}
            </dl>
          )}
        </div>
      )}
      {site.secrets && <Secrets secrets={site.secrets} />}
      {site.recent.length > 0 && (
        <div className="body stack-gap">
          <h3 className="conv-h">Recent repairs</h3>
          <ul className="plain">
            {site.recent.map((r, i) => (
              <li key={`${r.at}|${i}`}>
                <span className="mono">{r.tool}</span> {r.converged === true ? <St kind="ok">converged</St> : r.converged === false ? <St kind="warn">did not converge</St> : <St kind="nodata">{r.error ? "failed" : "no verdict"}</St>}{" "}
                <span className="faint">
                  {ago(ms(r.at), now)} by {r.actor}
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
      <dt className="mono">{k}</dt>
      <dd className="num">{v}</dd>
    </>
  );
}

function Checks({ checks, canRun, run }: { checks: ConvergenceCheck[]; canRun: boolean; run: (tool: string) => void }) {
  const sorted = [...checks].sort((a, b) => Number(a.ok) - Number(b.ok));
  return (
    <div className="scroll-x">
      <table className="list">
        <thead>
          <tr>
            <th>Check</th>
            <th>State</th>
            <th className="num">Present</th>
            <th>Repair</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.name} data-check={c.name}>
              <td>
                <b className="mono">{c.name}</b>
                {c.detail && <div className="faint">{c.detail}</div>}
              </td>
              <td>{c.ok ? <St kind="ok">ok</St> : <St kind="warn">drifted</St>}</td>
              <td className="num">{c.expected === null ? "" : `${c.present ?? "?"} of ${c.expected}`}</td>
              <td>
                {!c.repair ? (
                  <span className="faint">none Capsid may run</span>
                ) : c.repair_refusal ? (
                  <span className="faint" title={c.repair_refusal}>
                    <span className="mono">{c.repair}</span> not allowed
                  </span>
                ) : (
                  <span className="row-gap">
                    <span className="mono">{c.repair}</span>
                    <button type="button" className="btn" disabled={!canRun} onClick={() => run(c.repair as string)}>
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

function Secrets({ secrets }: { secrets: NonNullable<ConvergenceSite["secrets"]> }) {
  return (
    <div className="body stack-gap">
      <h3 className="conv-h">
        Worker secrets{secrets.script ? <span className="faint mono"> {secrets.script}</span> : null}
      </h3>
      {secrets.state !== "ok" ? (
        <div className="callout">
          <St kind="nodata">Not read</St> {secrets.reason}
        </div>
      ) : secrets.rows.length === 0 ? (
        <Empty kind="all-clear" title="The Worker has no secrets." />
      ) : (
        <ul className="plain">
          {secrets.rows.map((r) => (
            <li key={r.name}>
              <span className="mono">{r.name}</span> {r.set ? <St kind="ok">set</St> : <St kind="crit">not set</St>}
              {!r.expected && <span className="faint"> not named in the site's configuration</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="faint">
        Names only, from Cloudflare's secrets list on the watcher's pass{secrets.read_at ? ` (${secrets.read_at.slice(0, 16).replace("T", " ")} UTC)` : ""}. A value is never read.
      </div>
    </div>
  );
}
