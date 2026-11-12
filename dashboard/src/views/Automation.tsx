import { useState } from "react";
import { useApp } from "../app/ctx";
import { ReasonForm, SwitchWithReason } from "capsomer/react/switch-reason";
import { useApplySwitch } from "../ui/applySwitch";
import { Panel } from "capsomer/react/panel";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/switch.css";
import "capsomer/switch-reason.css";

// The overnight run, first on Settings (ruled 2026-09-30, DECIDE 5, 6 and 7; the UX audit's M3
// put it first). Every change is a switch that asks for a reason beside it, moves only when the
// change has applied, and offers Undo in the app's message.

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
  // A new mode from the server becomes the choice (adjusted while rendering, not in an effect).
  const [seenMode, setSeenMode] = useState(night.mode);
  if (seenMode !== night.mode) {
    setSeenMode(night.mode);
    if (isRunsOn(night.mode)) setNightChosen(night.mode);
  }
  const [pendingNight, setPendingNight] = useState<RunsOn | null>(null);
  const nightFocus = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLInputElement>('input[name="overnight-runs-on"]:checked')?.focus(),
    );
  const shownNight = pendingNight ?? (nightOn ? (night.mode as RunsOn) : nightChosen);

  return (
    <Panel
      flush
      title="Automation"
      id="automation"
      src="each change is recorded in Activity with its reason"
    >
      <div className="auto">
        <div className="auto-row">
          <div className="what">
            <b>Overnight run</b>
            <span>
              Runs the per-namespace drivers on this machine overnight, one session per repo, from
              the overnight plan. Hand-started tabs are unaffected.
            </span>
          </div>
          <SwitchWithReason
            id="sw-overnight"
            label="Overnight run"
            name="the overnight run"
            checked={nightOn}
            verb={(next) =>
              next
                ? `Turning the overnight run on, on ${runsOnLabel(nightChosen)}`
                : "Turning the overnight run off"
            }
            onApply={(next, why) =>
              apply(
                { action: "overnight", params: { value: next ? nightChosen : "off", reason: why } },
                {
                  action: "overnight",
                  params: { value: night.mode, reason: `Undo: ${why}`, undo: "true" },
                  focus: "sw-overnight",
                },
              )
            }
            note={
              nightOn
                ? `Running on ${runsOnLabel(night.mode as RunsOn)}.`
                : `Off. It runs on ${runsOnLabel(nightChosen)} when turned on.`
            }
          />
          <div className="runs">
            <fieldset className="cap-seg">
              <legend>Runs on</legend>
              <div className="cap-seg-options" data-size="sm">
                {RUNS_ON.map((r) => (
                  <label key={r.value} htmlFor={`overnight-runs-on-${r.value}`}>
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
                    />{" "}
                    {r.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <ReasonForm
              open={pendingNight !== null}
              id="overnight-runs-on-why"
              verb={`Changing the overnight run to run on ${runsOnLabel(pendingNight ?? nightChosen)}`}
              onCancel={() => {
                setPendingNight(null);
                nightFocus();
              }}
              onApply={async (why) => {
                if (!pendingNight) return;
                await apply(
                  { action: "overnight", params: { value: pendingNight, reason: why } },
                  {
                    action: "overnight",
                    params: { value: night.mode, reason: `Undo: ${why}`, undo: "true" },
                    focus: `overnight-runs-on-${night.mode}`,
                  },
                );
                setPendingNight(null);
                nightFocus();
              }}
            />
          </div>
          {night.decision && (
            <p className="state-note" id="overnight-decision">
              Decision recorded: {night.decision.decided_by}, {night.decision.decided_on}.{" "}
              {night.decision.ruling}. {night.decision.reasoning} Set{" "}
              {night.decision.set_at.slice(0, 10)} by {night.decision.set_by}:{" "}
              {night.decision.reason}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
