import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../app/ctx";
import { fetchNamespaces } from "../lib/api";
import { agentState, driverOf } from "../lib/derive";
import { ago, ms, pct, shortId, utc } from "../lib/format";
import { St } from "../ui/icons";
import type { PortalNamespace, PortalNamespaces } from "../types";
import { PageHead, Panel } from "./shared";

// The last good read stays on screen while a new one runs or after one fails.
interface Load {
  data: PortalNamespaces | null;
  loading: boolean;
  error: string | null;
}

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

function Row({ n, onChanged }: { n: PortalNamespace; onChanged: () => void }) {
  const { now, confirm } = useApp();
  const r = n.last_run;
  const rep = n.latest_report;
  const sk = n.skills;
  return (
    <tr data-row="">
      <td>
        <b className="mono">{n.namespace}</b>
        <div className="mt4">{n.paused != null ? <St kind="warn">Paused</St> : <St kind="ok">Not paused</St>}</div>
        {n.paused != null && <div className="src wrap">{n.paused || "no reason recorded"}</div>}
        {n.breaker.open && (
          <>
            <div className="mt4">
              <St kind="crit">Queue stopped</St>
            </div>
            <div className="src wrap">
              circuit breaker: {n.breaker.failed} jobs failed by their holders since {n.breaker.since} UTC (threshold {n.breaker.threshold})
            </div>
          </>
        )}
      </td>
      <td data-label="Driver">
        <Driver ns={n.namespace} />
      </td>
      <td data-label="Anchor">
        {n.anchor_problem ? <St kind="crit">Problem</St> : n.anchor_pinned ? <St kind="ok">Pinned</St> : <St kind="nodata">Not pinned</St>}
        {n.anchor_problem && <div className="src wrap">{n.anchor_problem}</div>}
      </td>
      <td data-label="Last run">
        {r ? (
          <>
            <span>{r.status}</span>
            <div className="src" title={utc(ms(r.started))}>
              {ago(ms(r.started), now)} · {r.attempts} tried, {r.kept} kept, {r.reverts} reverted
            </div>
          </>
        ) : (
          <St kind="nodata">No runs yet</St>
        )}
      </td>
      <td data-label="Best score">
        {n.best ? (
          <>
            <span className="num">{n.best.score}</span>
            <div className="src" title={utc(ms(n.best.recorded_at))}>
              {shortId(n.best.sha, 7)} · {ago(ms(n.best.recorded_at), now)}
            </div>
          </>
        ) : (
          <St kind="nodata">No best yet</St>
        )}
      </td>
      <td data-label="Integrity">
        {!rep ? (
          <St kind="nodata">No truth report</St>
        ) : rep.integrity == null ? (
          <>
            <St kind="nodata">No integrity figure</St>
            <div className="src">report {ago(ms(rep.generated), now)}</div>
          </>
        ) : (
          <>
            <span className="num">{pct(rep.integrity, 0)}</span>
            <div className="src">report {ago(ms(rep.generated), now)}</div>
          </>
        )}
      </td>
      <td data-label="Jobs" className="num nowrap">
        {n.jobs.queued} queued · {n.jobs.claimed} running
        <div className="src">
          {n.jobs.blocked} blocked · {n.jobs.done_today} done today
        </div>
      </td>
      <td data-label="Skills">
        <span className="num nowrap">
          {sk.live} live · {sk.candidate} candidate · {sk.retired} retired
        </span>
        <div className="src">{sk.use_rate == null ? "nothing offered yet" : `used ${pct(sk.use_rate, 0)} (${sk.used} of ${sk.offered} offered)`}</div>
      </td>
      <td className="ctl">
        <div className="toolbar col">
          {n.breaker.open && (
            <button type="button" className="btn" onClick={() => confirm({ action: "reset_breaker", params: { namespace: n.namespace }, title: `Reset the circuit breaker for ${n.namespace}`, onDone: onChanged })}>
              Reset breaker
            </button>
          )}
          {n.paused != null ? (
            <button type="button" className="btn" onClick={() => confirm({ action: "unpause", params: { namespace: n.namespace }, title: `Unpause ${n.namespace}`, onDone: onChanged })}>
              Unpause
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => confirm({ action: "pause", params: { namespace: n.namespace }, title: `Pause ${n.namespace}`, onDone: onChanged })}>
              Pause
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function Namespaces() {
  const { now, signOut } = useApp();
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const alive = useRef(true);
  const read = useCallback(async () => {
    setLoad((l) => ({ ...l, loading: true }));
    const r = await fetchNamespaces();
    if (!alive.current) return;
    if (r.kind === "ok") return setLoad({ data: r.value, loading: false, error: null });
    if (r.kind === "signed-out") return signOut();
    const message = r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message;
    setLoad((l) => ({ ...l, loading: false, error: message }));
  }, [signOut]);
  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);
  const data = load.data;
  return (
    <div className="page">
      <PageHead title="Namespaces">Every roster namespace: its improve loop, driver, truth report, jobs and skills. Pause stops the loop for one namespace; it asks for a reason.</PageHead>
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the namespaces: {load.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      <Panel
        title="Roster"
        count={data?.namespaces.length}
        src={
          <>
            {data ? `read ${ago(ms(data.generated), now)} · ` : ""}
            <button type="button" className="btn" disabled={load.loading} onClick={() => void read()}>
              {load.loading ? "Reading..." : "Read again"}
            </button>
          </>
        }
      >
        {!data && load.loading ? (
          <div className="loading" role="status">
            Reading the namespaces...
          </div>
        ) : data && data.namespaces.length ? (
          <div className="scroll-x reflow">
            <table className="list cards-below-1320">
              <thead>
                <tr>
                  <th>Namespace</th>
                  <th>Driver</th>
                  <th>Anchor</th>
                  <th>Last run</th>
                  <th>Best score</th>
                  <th>Integrity</th>
                  <th>Jobs</th>
                  <th>Skills</th>
                  <th>
                    <span className="sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.namespaces.map((n) => (
                  <Row key={n.namespace} n={n} onChanged={() => void read()} />
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="body faint">The roster has no namespaces.</div>
        ) : (
          <div className="body faint">No read yet.</div>
        )}
      </Panel>
    </div>
  );
}
