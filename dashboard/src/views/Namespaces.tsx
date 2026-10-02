import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "capsomer/react/empty";
import { useApp } from "../app/ctx";
import { fetchNamespaces } from "../lib/api";
import { agentState, driverOf } from "../lib/derive";
import { ago, ms, pct, shortId } from "../lib/format";
import { St } from "../ui/icons";
import { AutomationSwitch, ReasonForm, useApplySwitch } from "../ui/Switch";
import { When } from "../ui/When";
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
  const seat = feed.live.seat_start;
  const mode = feed.live.loop.mode;
  const loopOn = isRunsOn(mode);
  // What the loop runs on when it is turned on. Nothing is stored while it is off, so
  // the choice starts at Subscription and holds for this page only until the switch
  // turns on (DECIDE 6).
  const [chosen, setChosen] = useState<RunsOn>(loopOn ? mode : "subscription");
  useEffect(() => {
    if (isRunsOn(mode)) setChosen(mode);
  }, [mode]);
  // A change of "Runs on" while the loop is on is a change of mode, so it asks a reason.
  const [pendingRuns, setPendingRuns] = useState<RunsOn | null>(null);
  const radioFocus = () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[name="runs-on"]:checked')?.focus());
  const shownRuns = pendingRuns ?? (loopOn ? mode : chosen);

  return (
    <Panel flush title="Automation" src="each change is recorded in Activity with its reason">
      <div className="auto">
        <div className="auto-row">
          <div className="what">
            <b>Seat start</b>
            <span>Starts a Claude Code session on GitHub's runners for a queued capsid or dustinedwards job, billed to the subscription, up to the cap.</span>
          </div>
          <AutomationSwitch
            id="sw-seat"
            label="Seat start"
            checked={seat.enabled}
            verb={(next) => (next ? "Turning seat start on" : "Turning seat start off")}
            onApply={(next, why) =>
              apply(
                { action: "seat_start", params: { value: next ? "on" : "off", reason: why } },
                { action: "seat_start", params: { value: next ? "off" : "on", reason: `Undo: ${why}`, undo: "true" }, focus: "sw-seat" },
              )
            }
          >
            <span className="state-note">
              {seat.enabled ? `${seat.in_flight} of ${seat.max_sessions} session${seat.max_sessions === 1 ? "" : "s"} in flight` : "No session starts until this is on."}
            </span>
          </AutomationSwitch>
        </div>
        <div className="auto-row">
          <div className="what">
            <b>Improve loop</b>
            <span>Improve attempts in every roster namespace that is not paused, within the month's budget.</span>
          </div>
          <AutomationSwitch
            id="sw-loop"
            label="Improve loop"
            checked={loopOn}
            verb={(next) => (next ? `Turning the improve loop on, on ${runsOnLabel(chosen)}` : "Turning the improve loop off")}
            onApply={(next, why) =>
              apply(
                { action: "mode", params: { value: next ? chosen : "off", reason: why } },
                { action: "mode", params: { value: mode, reason: `Undo: ${why}`, undo: "true" }, focus: "sw-loop" },
              )
            }
          >
            <span className="state-note">{loopOn ? `Running on ${runsOnLabel(mode)}.` : `Off. It runs on ${runsOnLabel(chosen)} when turned on.`}</span>
          </AutomationSwitch>
          <div className="runs">
            <span id="runs-on-label">Runs on</span>
            <span className="seg" role="radiogroup" aria-labelledby="runs-on-label">
              {RUNS_ON.map((r) => (
                <Fragment key={r.value}>
                  <input
                    type="radio"
                    name="runs-on"
                    id={`runs-on-${r.value}`}
                    value={r.value}
                    checked={shownRuns === r.value}
                    onChange={() => {
                      if (!loopOn) return setChosen(r.value);
                      setPendingRuns(r.value === mode ? null : r.value);
                    }}
                  />
                  <label htmlFor={`runs-on-${r.value}`}>{r.label}</label>
                </Fragment>
              ))}
            </span>
            {pendingRuns && (
              <ReasonForm
                id="runs-on-why"
                verb={`Changing the improve loop to run on ${runsOnLabel(pendingRuns)}`}
                onCancel={() => {
                  setPendingRuns(null);
                  radioFocus();
                }}
                onApply={async (why) => {
                  const err = await apply(
                    { action: "mode", params: { value: pendingRuns, reason: why } },
                    { action: "mode", params: { value: mode, reason: `Undo: ${why}`, undo: "true" }, focus: `runs-on-${mode}` },
                  );
                  if (!err) {
                    setPendingRuns(null);
                    radioFocus();
                  }
                  return err;
                }}
              />
            )}
          </div>
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

// The loop's detail for one namespace, under the row's disclosure: at 1440 px the nine
// columns did not fit without the card layout, and five of them are empty while the loop
// is off (audit finding 15).
function LoopDetail({ n }: { n: PortalNamespace }) {
  const { now } = useApp();
  const r = n.last_run;
  const rep = n.latest_report;
  const sk = n.skills;
  return (
    <dl className="kv">
      <dt>Anchor</dt>
      <dd>
        {n.anchor_problem ? <St kind="crit">Problem</St> : n.anchor_pinned ? <St kind="ok">Pinned</St> : <St kind="nodata">Not pinned</St>}
        {n.anchor_problem && <div className="src wrap">{n.anchor_problem}</div>}
      </dd>
      <dt>Last run</dt>
      <dd>
        {r ? (
          <>
            {r.status}, {ago(ms(r.started), now)}: {r.attempts} tried, {r.kept} kept, {r.reverts} reverted. <When t={ms(r.started)} />
          </>
        ) : (
          <St kind="nodata">No runs yet</St>
        )}
      </dd>
      <dt>Best score</dt>
      <dd>
        {n.best ? (
          <>
            <span className="num">{n.best.score}</span> <span className="mono">{shortId(n.best.sha, 7)}</span>, {ago(ms(n.best.recorded_at), now)}. <When t={ms(n.best.recorded_at)} />
          </>
        ) : (
          <St kind="nodata">No best yet</St>
        )}
      </dd>
      <dt>Integrity</dt>
      <dd>
        {!rep ? (
          <St kind="nodata">No truth report</St>
        ) : (
          <>
            {rep.integrity == null ? <St kind="nodata">No integrity figure</St> : <span className="num">{pct(rep.integrity, 0)}</span>} <span className="faint">report {ago(ms(rep.generated), now)}</span>
          </>
        )}
      </dd>
      <dt>Skills</dt>
      <dd>
        <span className="num">
          {sk.live} live · {sk.candidate} candidate · {sk.retired} retired
        </span>
        <div className="src">{sk.use_rate == null ? "nothing offered yet" : `used ${pct(sk.use_rate, 0)} (${sk.used} of ${sk.offered} offered)`}</div>
      </dd>
    </dl>
  );
}

function Row({ n, onChanged }: { n: PortalNamespace; onChanged: () => void }) {
  const { feed, confirm } = useApp();
  const apply = useApplySwitch();
  const [open, setOpen] = useState(false);
  // The pause state is the feed's, which the perform returns, so the switch moves as
  // soon as the change applies; the rest of the row is the namespaces read.
  const live = feed.live.namespaces.find((x) => x.name === n.namespace);
  const paused = live ? live.paused : n.paused;
  const loopOn = feed.live.loop.mode !== "off";
  const swId = `sw-ns-${n.namespace}`;
  const detailId = `ns-detail-${n.namespace}`;
  return (
    <>
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
        <td data-label="Improve loop" className="w30">
          <AutomationSwitch
            id={swId}
            label={`Improve loop for ${n.namespace}`}
            checked={paused == null}
            verb={(next) => (next ? `Unpausing ${n.namespace}` : `Pausing ${n.namespace}`)}
            onApply={(next, why) =>
              next
                ? // Undo of an unpause pauses it again with the reason it had, so it reads as before.
                  apply(
                    { action: "unpause", params: { namespace: n.namespace, reason: why } },
                    { action: "pause", params: { namespace: n.namespace, reason: paused || `Undo: ${why}`, undo: "true" }, focus: swId },
                  )
                : apply(
                    { action: "pause", params: { namespace: n.namespace, reason: why } },
                    { action: "unpause", params: { namespace: n.namespace, reason: `Undo: ${why}`, undo: "true" }, focus: swId },
                  )
            }
          >
            <span className="state-note wrap">{paused != null ? `Paused: ${paused || "no reason recorded"}` : loopOn ? "Running" : "Not paused. The loop is off for every namespace."}</span>
          </AutomationSwitch>
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
        <td className="ctl">
          <div className="toolbar">
            {n.breaker.open && (
              <button type="button" className="btn" onClick={() => confirm({ action: "reset_breaker", params: { namespace: n.namespace }, title: `Reset the circuit breaker for ${n.namespace}`, onDone: onChanged })}>
                Reset breaker
              </button>
            )}
            <button type="button" className="btn" aria-expanded={open} aria-controls={detailId} aria-label={`Loop detail for ${n.namespace}`} onClick={() => setOpen((o) => !o)}>
              Loop detail
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr id={detailId} className="detailrow">
          <td colSpan={5}>
            <LoopDetail n={n} />
          </td>
        </tr>
      )}
    </>
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
      <PageHead title="Namespaces" />
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
                  <th>Improve loop</th>
                  <th>Driver</th>
                  <th>Jobs</th>
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
