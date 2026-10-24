import { Suspense, lazy, useEffect, useState } from "react";
import { Spinner } from "capsomer/react/empty";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { LIVE, fetchDigest, fetchPlan, useAnswer } from "../lib/api";
import { ago, ms } from "../lib/format";
import { readPref, writePref } from "../lib/prefs";
import type { PortalDigest, PortalPlan } from "../types";
import { St } from "../ui/icons";

// The Tonight plan on the Queue and the "since you last looked" strip on Needs you
// (docs/design/design-portal-evaluation.md, DECIDE 3, ruled 2026-10-09). Each reads its
// own route when its page opens and again with each feed: GET /portal/api/plan and
// GET /portal/api/digest, the readers behind `jobs` list view plan and view digest, so
// the Portal and chat cannot disagree. Neither changes anything.

// Chart 4, Tonight as a timeline, loads with the Queue that shows it, not with the digest
// strip Needs you takes from this file.
const TonightTimeline = lazy(() => import("./TrendCharts").then((m) => ({ default: m.TonightTimeline })));


function Failed({ what, error }: { what: string; error: string | null }) {
  return error ? (
    <div className="callout crit" role="alert">
      Could not read {what}: {error}
    </div>
  ) : null;
}

// ---- Tonight -----------------------------------------------------------------------------

const SOURCE: Record<PortalPlan["lanes"][number]["jobs"][number]["estimate_source"], string> = {
  policy: "from the policy",
  record: "from its record",
  default: "default",
};

export function Tonight() {
  const { now } = useApp();
  const load = useAnswer<PortalPlan>([LIVE, "plan"], fetchPlan);
  const plan = load.data;
  const planned = plan ? plan.lanes.reduce((n, l) => n + l.jobs.length, 0) : 0;
  return (
    <Panel
      flush
      title="Tonight"
      id="tonight"
      section="Tonight"
      count={plan ? planned : undefined}
      src={plan ? `planned ${ago(ms(plan.generated), now)} · ${plan.budget_minutes} min budget` : "jobs list view plan"}
    >
      <Failed what="the plan" error={load.error} />
      {plan && plan.policy !== "document" && (
        <div className="callout warn">{plan.policy_note ?? (plan.policy === "default" ? "No overnight policy document: every repo counts as heavy." : "The overnight policy document did not parse.")}</div>
      )}
      {!plan && load.loading ? (
        <div className="loading" role="status">
          <Spinner label="Reading tonight's plan..." />
        </div>
      ) : plan && (planned || plan.skipped.length) ? (
        <>
          {planned > 0 && (
            <Suspense fallback={null}>
              <TonightTimeline plan={plan} />
            </Suspense>
          )}
          {plan.lanes.map((lane) => (
            <div className="qgroup" key={lane.repo} data-lane={lane.repo}>
              <h3>
                <span className="mono">{lane.repo}</span>{" "}
                <span className="num faint">
                  {lane.planned_minutes} min{lane.heavy ? " · heavy, shares the budget" : ""}
                </span>
              </h3>
              {lane.jobs.map((j) => (
                <div className="qrow" key={j.id} data-row="" data-open={`job:${j.id}`} tabIndex={0}>
                  {j.gated ? <St kind="blocked">Gated</St> : <St kind="queued">Planned</St>}
                  <div className="t">
                    <b>{j.title}</b>
                    <div>
                      about {j.estimate_minutes} min, {SOURCE[j.estimate_source]}
                      {j.gated ? " · its risky step goes in the pull request for the seat" : ""}
                    </div>
                  </div>
                  <div className="m">
                    <span className="ns">{j.namespace}</span>
                    <br />
                    priority {j.priority}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {plan.skipped.length > 0 && (
            <div className="qgroup" data-group="skipped">
              <h3>
                Skipped <span className="num faint">{plan.skipped.length}</span>
              </h3>
              {plan.skipped.map((j) => (
                <div className="qrow" key={j.id} data-row="" data-open={`job:${j.id}`} tabIndex={0}>
                  <St kind="nodata">Skipped</St>
                  <div className="t">
                    <b>{j.title}</b>
                    <div className="why">{j.reason}</div>
                  </div>
                  <div className="m">
                    <span className="ns">{j.namespace}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {plan.truncated && <div className="body faint">More jobs are queued than the plan reads; the rest wait for another night.</div>}
        </>
      ) : plan ? (
        <Empty kind="all-clear" title="Nothing is queued for tonight." />
      ) : (
        <div className="body faint">No read yet.</div>
      )}
    </Panel>
  );
}

// ---- Since you last looked -----------------------------------------------------------------

// When this browser last opened Needs you. A per-viewer convenience: with no record, or
// storage blocked, the strip reports the last 24 hours, the digest's own default.
const LAST_LOOKED_PREF = "wf-last-looked";
const DAY = 86_400_000;

export function SinceLastLooked() {
  const { now } = useApp();
  // Read once, when the page opens, then moved to now: the next visit reports from here.
  const [since] = useState(() => {
    const saved = readPref(LAST_LOOKED_PREF);
    const at = saved ? Date.parse(saved) : NaN;
    return Number.isNaN(at) ? new Date(now - DAY).toISOString() : new Date(at).toISOString();
  });
  // Once per visit: the clock ticking on is not a new look.
  useEffect(() => writePref(LAST_LOOKED_PREF, new Date(now).toISOString()), []);
  const load = useAnswer<PortalDigest>([LIVE, "digest", since], () => fetchDigest(since));
  const d = load.data;
  const merged = d?.pull_requests_merged ?? 0;
  return (
    <Panel title="Since you last looked" id="since" src={`since ${ago(ms(since), now)} · jobs list view digest`}>
      <Failed what="the digest" error={load.error} />
      {!d && load.loading ? (
        <div className="loading" role="status">
          <Spinner label="Reading what happened..." />
        </div>
      ) : d ? (
        <div className="digest">
          <p className="digest-line" data-digest="">
            <b className="num">{d.finished.length}</b> finished · <b className="num">{merged}</b> merged · <b className="num">{d.pull_requests_ready.length}</b> ready for you ·{" "}
            <b className="num">{d.blocked.length}</b> blocked
          </p>
          {(d.pull_requests_ready.length > 0 || d.blocked.length > 0) && (
            // One line first (UX audit, the proposed Needs you); the lists behind it.
            <details className="digest-more">
              <summary>Show them</summary>
          {d.pull_requests_ready.length > 0 && (
            <ul className="digest-list">
              {d.pull_requests_ready.map((p) => (
                <li key={p.url}>
                  <a href={p.url} target="_blank" rel="noreferrer noopener">
                    {p.url.replace("https://github.com/", "")}
                  </a>{" "}
                  <span className="faint">{p.state === "unchecked" ? "not checked yet" : p.state}</span>
                </li>
              ))}
            </ul>
          )}
          {d.blocked.length > 0 && (
            <ul className="digest-list">
              {d.blocked.map((b) => (
                <li key={b.id} data-row="" data-open={`job:${b.id}`} tabIndex={0} className="click">
                  <b>{b.title}</b> <span className="faint">blocked {ago(ms(b.at), now)}</span>
                </li>
              ))}
            </ul>
          )}
            </details>
          )}
          {d.truncated.length > 0 && <p className="faint small">Cut short: {d.truncated.join("; ")}.</p>}
        </div>
      ) : (
        <div className="faint">No read yet.</div>
      )}
    </Panel>
  );
}
