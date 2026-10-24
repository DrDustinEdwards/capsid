import { Fragment, useEffect, useState } from "react";
import { Spinner } from "capsomer/react/empty";
import { useApp } from "../app/ctx";
import { LIVE, fetchNamespaces, useAnswer } from "../lib/api";
import { agentState, driverOf } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import { AutomationSwitch, ReasonForm, useApplySwitch } from "../ui/Switch";
import type { PortalNamespace, PortalNamespaces } from "../types";
import { Panel } from "capsomer/react/panel";

// The Automation panel and the Projects roster, both on Settings (ruled 2026-09-30, DECIDE
// 5, 6 and 7; the UX audit's M3 put Automation first). Every automation change is a switch
// that asks for a reason beside it, moves only when the change has applied, and offers
// Undo in the app's message. A project paused after repeated failures (the queue's circuit
// breaker, src/job-breaker.ts) is reset one way, so the reset keeps its preview and
// confirm; Needs you offers the same Reset.

type RunsOn = "subscription" | "api";
const RUNS_ON: ReadonlyArray<{ value: RunsOn; label: string }> = [
  { value: "subscription", label: "Subscription" },
  { value: "api", label: "API" },
];
const runsOnLabel = (v: RunsOn) => RUNS_ON.find((r) => r.value === v)?.label ?? v;
const isRunsOn = (m: string): m is RunsOn => m === "subscription" || m === "api";

export function Automation() {
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
    <Panel flush title="Automation" id="automation" src="each change is recorded in Activity with its reason">
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

export function Projects() {
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
