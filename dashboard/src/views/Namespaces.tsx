import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "capsomer/react/empty";
import { useApp } from "../app/ctx";
import { fetchNamespaces } from "../lib/api";
import { agentState, driverOf } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import { AutomationSwitch, ReasonForm, useApplySwitch } from "../ui/Switch";
import type { PortalNamespace, PortalNamespaces } from "../types";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

// The Automation panel and the roster (ruled 2026-09-30, DECIDE 5, 6 and 7). Every
// automation change is a switch that asks for a reason beside it, moves only when the
// change has applied, and offers Undo in the app's message. The breaker reset is one-way,
// so it keeps its preview and confirm.

// The last good read stays on screen while a new one runs or after one fails.
interface Load {
  data: PortalNamespaces | null;
  loading: boolean;
  error: string | null;
}

type RunsOn = "subscription" | "api";
const RUNS_ON: ReadonlyArray<{ value: RunsOn; label: string }> = [
  { value: "subscription", label: "Subscription" },
  { value: "api", label: "API" },
];
const runsOnLabel = (v: RunsOn) => RUNS_ON.find((r) => r.value === v)?.label ?? v;
const isRunsOn = (m: string): m is RunsOn => m === "subscription" || m === "api";

function Automation() {
  const { feed } = useApp();
  const apply = useApplySwitch();
  // The overnight run: a switch and a "Runs on" radio group.
  // Choosing the subscription records Dustin's decision, its date and its reasoning with
  // the switch (src/overnight.ts); the Worker does the recording, and the note below
  // shows it. The choice starts at API when off: that is the setting the terms allow
  // without a decision.
  const night = feed.live.overnight;
  const nightOn = isRunsOn(night.mode);
  const [nightChosen, setNightChosen] = useState<RunsOn>(nightOn ? (night.mode as RunsOn) : "api");
  useEffect(() => {
    if (isRunsOn(night.mode)) setNightChosen(night.mode);
  }, [night.mode]);
  const [pendingNight, setPendingNight] = useState<RunsOn | null>(null);
  const nightFocus = () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[name="overnight-runs-on"]:checked')?.focus());
  const shownNight = pendingNight ?? (nightOn ? (night.mode as RunsOn) : nightChosen);

  return (
    <Panel flush title="Automation" src="each change is recorded in Activity with its reason">
      <div className="auto">
        <div className="auto-row">
          <div className="what">
            <b>Overnight run</b>
            <span>Runs the per-namespace drivers on this machine overnight, one session per repo, from the overnight plan. Hand-started tabs are unaffected.</span>
          </div>
          <AutomationSwitch
            id="sw-overnight"
            label="Overnight run"
            checked={nightOn}
            verb={(next) => (next ? `Turning the overnight run on, on ${runsOnLabel(nightChosen)}` : "Turning the overnight run off")}
            onApply={(next, why) =>
              apply(
                { action: "overnight", params: { value: next ? nightChosen : "off", reason: why } },
                { action: "overnight", params: { value: night.mode, reason: `Undo: ${why}`, undo: "true" }, focus: "sw-overnight" },
              )
            }
          >
            <span className="state-note">{nightOn ? `Running on ${runsOnLabel(night.mode as RunsOn)}.` : `Off. It runs on ${runsOnLabel(nightChosen)} when turned on.`}</span>
          </AutomationSwitch>
          <div className="runs">
            <span id="overnight-runs-on-label">Runs on</span>
            <span className="seg" role="radiogroup" aria-labelledby="overnight-runs-on-label">
              {RUNS_ON.map((r) => (
                <Fragment key={r.value}>
                  <input
                    type="radio"
                    name="overnight-runs-on"
                    id={`overnight-runs-on-${r.value}`}
                    value={r.value}
                    checked={shownNight === r.value}
                    onChange={() => {
                      if (!nightOn) return setNightChosen(r.value);
                      setPendingNight(r.value === night.mode ? null : r.value);
                    }}
                  />
                  <label htmlFor={`overnight-runs-on-${r.value}`}>{r.label}</label>
                </Fragment>
              ))}
            </span>
            {pendingNight && (
              <ReasonForm
                id="overnight-runs-on-why"
                verb={`Changing the overnight run to run on ${runsOnLabel(pendingNight)}`}
                onCancel={() => {
                  setPendingNight(null);
                  nightFocus();
                }}
                onApply={async (why) => {
                  const err = await apply(
                    { action: "overnight", params: { value: pendingNight, reason: why } },
                    { action: "overnight", params: { value: night.mode, reason: `Undo: ${why}`, undo: "true" }, focus: `overnight-runs-on-${night.mode}` },
                  );
                  if (!err) {
                    setPendingNight(null);
                    nightFocus();
                  }
                  return err;
                }}
              />
            )}
          </div>
          {night.decision && (
            <p className="state-note" id="overnight-decision">
              Decision recorded: {night.decision.decided_by}, {night.decision.decided_on}. {night.decision.ruling}. {night.decision.reasoning} Set {night.decision.set_at.slice(0, 10)} by {night.decision.set_by}: {night.decision.reason}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
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
          <button type="button" className="btn" onClick={() => confirm({ action: "reset_breaker", params: { namespace: n.namespace }, title: `Reset the circuit breaker for ${n.namespace}`, onDone: onChanged })}>
            Reset breaker
          </button>
        )}
      </td>
    </tr>
  );
}

export function Namespaces({ embedded = false }: { embedded?: boolean } = {}) {
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
    <div className={embedded ? "embedded" : "page"}>
      {!embedded && <PageHead title="Namespaces" />}
      <Automation />
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the namespaces: {load.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      <Panel
        flush
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
            <Spinner label="Reading the namespaces..." />
          </div>
        ) : data && data.namespaces.length ? (
          <div className="scroll-x reflow">
            <table className="list cards-below-1100 roster">
              <thead>
                <tr>
                  <th>Namespace</th>
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
