import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { Suspense } from "react";
import { useApp } from "../app/ctx";
import { ciState, type Kind } from "../lib/derive";
import { checkWords } from "../../../src/check-words";
import { age, ago, ms, utc } from "../lib/format";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
import { Empty } from "capsomer/react/empty";
import { approveRequest, canApprove, closeRequest, prAnchor, prName, prUrl } from "../lib/pr-actions";
import { NoSnapshot, PageHead } from "./shared";
import type { OpsAwaitingSeat, PortalMergeUnits } from "../types";
import { LIVE, fetchMergeUnits, useAnswer } from "../lib/api";

function prLabel(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]} #${m[2]}` : url;
}

// Chart 11, each default branch by day for 14 days, from GET /portal/api/trends. Lazy, so
// Enarratio loads with Health and not with Pull requests, which shares this file.
const CiHistory = trendChart("CiHistory");
// Chart 7, merges per week by who acted, loads the same way for Pull requests.
const MergesChart = trendChart("MergesChart");
const DeploysTable = trendChart("DeploysTable");

// CI's default-branch table, a section of Health (design-portal-evaluation.md section 2).
export function DefaultBranches() {
  const { feed, now } = useApp();
  const snap = feed.snapshot;
  return (
    <>
      <Panel flush title="Default branches" src="watcher ci check · GitHub App">
        {snap ? (
          <div className="scroll-x">
            <table className="list">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Latest run</th>
                  <th>Sha</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snap.ci.map((c) => {
                  const st = ciState(c);
                  return (
                    // The whole row opens the run (the UX audit's m5: "run" was a 20 by 16 px target).
                    <tr key={c.namespace} className={c.latest?.url ? "click" : undefined}>
                      <td>
                        <b>{c.namespace}</b>
                      </td>
                      <td>
                        <St kind={st.kind}>{st.label}</St>
                      </td>
                      <td className="mono">{c.latest ? c.latest.head_sha.slice(0, 7) : "-"}</td>
                      <td className="num" title={c.latest ? utc(ms(c.latest.created_at)) : undefined}>
                        {c.latest ? ago(ms(c.latest.created_at), now) : <span className="faint">runs could not be read</span>}
                      </td>
                      <td>
                        {c.latest?.url && (
                          <a className="stretch" href={c.latest.url} target="_blank" rel="noopener noreferrer" aria-label={`Open the latest ${c.namespace} run on GitHub`}>
                            Open run
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <NoSnapshot />
        )}
      </Panel>
      <Suspense fallback={null}>
        <CiHistory />
      </Suspense>
    </>
  );
}

// Pull requests (design section 2; the UX audit of 2026-10-19, B2 and m6): what waits for
// you first, each pull request a row on a wide screen and a card with full-width Approve and
// Close on a phone; then Auto-merge (the signed policy and its Load from repo and sign, and
// the safety meter), the pull requests recorded in the last 7 days, and the chart
// last. The default-branch table is on Health.
export function PullRequests() {
  const { feed, now, confirm } = useApp();
  const live = feed.live;
  return (
    <div className="page">
      <PageHead title="Pull requests" />
      <Panel flush title="Waiting for you" id="waiting-prs" count={live.awaiting_seat.length} src="auto-merge left these for a person">
        {live.awaiting_seat.length ? (
          <ul className="wlist prcards">
            {live.awaiting_seat.map((a) => (
              <WaitingPr key={`${a.repo}-${a.number}`} a={a} />
            ))}
          </ul>
        ) : (
          <Empty kind="all-clear" title="No pull request is waiting for you." />
        )}
      </Panel>
      {/* Auto-merge, one section: whether the signed policy loads, then the safety meter.
          A pause alert opens it (src/push.ts, /prs#auto-merge). */}
      <div className="embedded" id="auto-merge">
        {/* The signed auto-merge policy (src/auto-merge-policy.ts): whether the Worker loads it,
            and the control that writes it from docs/policy/auto-merge.md and signs it
            (sign_policy_from_repo). The version is typed in the dialog. */}
        <Panel title="Auto-merge policy" src="signed policy · loadMergePolicy">
          <div className="stack-gap">
            {live.merge_policy.loads ? (
              <p>
                <St kind="ok">Loads</St> version {live.merge_policy.version}, {live.merge_policy.enabled ? "enabled" : "disabled"}.
              </p>
            ) : (
              <>
                <p>
                  <St kind="crit">Does not load</St> Nothing is auto-merged until it does.
                </p>
                <p className="muted prewrap">{live.merge_policy.reason}</p>
              </>
            )}
            <div className="toolbar">
              <button
                type="button"
                className="btn"
                onClick={() => confirm({ action: "sign_policy_from_repo", params: {}, title: "Load the auto-merge policy from the repo and sign it" })}
              >
                Load from repo and sign
              </button>
            </div>
          </div>
        </Panel>
        {/* The auto-merge safety meter (src/merge-safety.ts): the last seven days per
            project, and the shutoff. Resuming is the automerge_resume control. */}
        {live.merge_safety && (
          <Panel flush title="Auto-merge, last 7 days" id="merge-safety" count={live.merge_safety.namespaces.length} src="the tick's safety meter">
            <div className="scroll-x reflow">
              <table className="list cards-below-1100">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Auto</th>
                    <th>Approved</th>
                    <th>Verified</th>
                    <th>Rolled back</th>
                    <th>Rollback failed</th>
                    <th>Reverts</th>
                    <th>State</th>
                    <th>Why</th>
                    <th>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live.merge_safety.namespaces.map((n) => (
                    <tr key={n.namespace}>
                      <td className="nowrap">
                        <b>{n.namespace}</b>
                      </td>
                      <td className="num" data-label="Auto">{n.auto_merged}</td>
                      <td className="num" data-label="Approved">{n.approved}</td>
                      <td className="num" data-label="Verified">{n.deploys_verified}</td>
                      <td className="num" data-label="Rolled back">{n.rolled_back}</td>
                      <td className="num" data-label="Rollback failed">{n.rollback_failed}</td>
                      <td className="num" data-label="Reverts">{n.reverts}</td>
                      <td data-label="State">{n.paused ? <St kind="warn">Paused</St> : <span className="faint">running</span>}</td>
                      {/* The reason wraps in its own cell: a status chip does not wrap. */}
                      <td className="muted" data-label="Why">{n.paused?.reason ?? ""}</td>
                      <td>
                        {n.paused && (
                          <button
                            type="button"
                            className="btn"
                            aria-label={`Resume auto-merge for ${n.namespace}`}
                            onClick={() => confirm({ action: "automerge_resume", params: { namespace: n.namespace }, title: `Resume auto-merge for ${n.namespace}` })}
                          >
                            Resume
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
        <MergeUnits />
      </div>
      <Panel flush title="Pull requests, last 7 days" src="recorded against jobs" count={live.prs.length}>
        <div className="scroll-x reflow">
          <table className="list cards-below-1100">
            <thead>
              <tr>
                <th>PR</th>
                <th>Job</th>
                <th>State</th>
                <th>Verified</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {live.prs.map((p) => {
                const job = live.jobs.find((j) => j.id === p.job_id);
                return (
                  <tr key={`${p.job_id}-${p.pr_url}`} className={job ? "click" : undefined} data-row="" data-open={job ? `job:${job.id}` : undefined} tabIndex={job ? 0 : undefined}>
                    <td className="mono">
                      <a href={p.pr_url} target="_blank" rel="noopener noreferrer">
                        {prLabel(p.pr_url)}
                      </a>
                    </td>
                    <td data-label="Job">{job ? job.title : <span className="mono faint">{p.job_id}</span>}</td>
                    <td data-label="State">{p.merged === true ? <St kind="ok">Merged</St> : p.merged === false ? <St kind="crit">Not merged</St> : <St kind="run">Open</St>}</td>
                    <td className="num" data-label="Verified">{p.merge_verified_at ? ago(ms(p.merge_verified_at), now) : <span className="faint">not yet</span>}</td>
                    <td className="num" data-label="Recorded">{ago(ms(p.recorded_at), now)}</td>
                  </tr>
                );
              })}
              {!live.prs.length && (
                <tr>
                  <td colSpan={5} className="faint">
                    No pull requests recorded in the last 7 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <ChartSlot>
        <MergesChart />
      </ChartSlot>
      <ChartSlot>
        <DeploysTable />
      </ChartSlot>
    </div>
  );
}

// The merge units (a project and a kind of change, such as sample/docs; src/merge-units.ts):
// those the signed policy promotes to auto, those suspended after a rollback of an unattended
// merge, and the tick's promote and demote proposals. Each row offers its control: Demote and
// Promote sign the policy's next version (sign_policy_change, the version typed), and Lift
// suspension is unit_resume, with a reason. docs/autonomy.md, "Earned promotion and demotion".
type UnitRow = { unit: string; state: "auto" | "suspended" | "promote" | "demote"; why: string };

function unitRows(promoted: readonly string[], units: PortalMergeUnits): UnitRow[] {
  const rows = new Map<string, UnitRow>();
  for (const u of promoted) rows.set(u, { unit: u, state: "auto", why: "" });
  for (const p of units.proposals) {
    // A demote proposal is for a unit in the list; a promote one for a unit not yet in it.
    if (p.kind === "demote" && !rows.has(p.unit)) continue;
    rows.set(p.unit, { unit: p.unit, state: p.kind, why: p.title });
  }
  for (const s of units.suspended) {
    const row = rows.get(s.unit);
    rows.set(s.unit, { unit: s.unit, state: "suspended", why: row?.state === "demote" ? row.why : s.reason });
  }
  return [...rows.values()].sort((a, b) => a.unit.localeCompare(b.unit));
}

const UNIT_STATE: Record<UnitRow["state"], { kind: Kind; label: string }> = {
  auto: { kind: "ok", label: "Auto" },
  suspended: { kind: "warn", label: "Suspended" },
  promote: { kind: "queued", label: "Ready to promote" },
  demote: { kind: "warn", label: "Proposed for removal" },
};

function MergeUnits() {
  const { feed, confirm } = useApp();
  // Its own read (GET /portal/api/merge-units), again with each feed, so a lift drops its row.
  const load = useAnswer([LIVE, "merge-units"], fetchMergeUnits);
  const policy = feed.live.merge_policy;
  const units = load.data;
  if (!policy.loads) return null;
  if (!units)
    return (
      <Panel title="Merge units" id="merge-units">
        <p className={load.error ? "prewrap" : "muted"}>{load.error ? `The merge units could not be read: ${load.error}` : "Reading the merge units..."}</p>
      </Panel>
    );
  const rows = unitRows(policy.units, units);
  const next = String(Number(policy.version) + 1);
  const sign = (change: "promote" | "demote", unit: string) =>
    confirm({
      action: "sign_policy_change",
      params: { change, unit },
      title: change === "promote" ? `Promote ${unit} to auto-merge` : `Remove ${unit} from auto-merge`,
      confirmHelp: `The policy's next version, ${next}. It decides what merges with no human, so it is typed, not clicked.`,
    });
  const suspended = new Set(units.suspended.map((s) => s.unit));
  return (
    <Panel flush title="Merge units" id="merge-units" count={rows.length} src={units.generated ? `judged ${utc(ms(units.generated))}` : "not judged yet"}>
      {rows.length ? (
        <div className="scroll-x reflow">
          <table className="list cards-below-1100">
            <thead>
              <tr>
                <th>Unit</th>
                <th>State</th>
                <th>Why</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = UNIT_STATE[r.state];
                const listed = policy.units.includes(r.unit);
                return (
                  <tr key={r.unit}>
                    <td className="mono nowrap">{r.unit}</td>
                    <td data-label="State">
                      <St kind={st.kind}>{st.label}</St>
                    </td>
                    <td className="muted" data-label="Why">
                      {r.why || (r.state === "auto" ? "merges with no human when every other check passes" : "")}
                    </td>
                    <td>
                      <span className="toolbar">
                        {suspended.has(r.unit) && (
                          <button type="button" className="btn" aria-label={`Lift the suspension of ${r.unit}`} onClick={() => confirm({ action: "unit_resume", params: { unit: r.unit }, title: `Lift the suspension of ${r.unit}` })}>
                            Lift suspension
                          </button>
                        )}
                        {r.state === "promote" && (
                          <button type="button" className="btn primary" aria-label={`Promote ${r.unit}`} onClick={() => sign("promote", r.unit)}>
                            Promote
                          </button>
                        )}
                        {listed && (
                          <button type="button" className="btn" aria-label={`Demote ${r.unit}`} onClick={() => sign("demote", r.unit)}>
                            Demote
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty kind="all-clear" title="No unit is promoted, suspended or ready to promote." />
      )}
    </Panel>
  );
}

// One pull request waiting for you. Its buttons are the same controls Needs you uses
// (lib/pr-actions.ts); on a phone they sit under it, full width (styles.css, .wact).
function WaitingPr({ a }: { a: OpsAwaitingSeat }) {
  const { now, confirm } = useApp();
  const name = prName(a);
  return (
    <li className="wrow prcard" data-row="" id={prAnchor(a)}>
      <div className="wmain">
        <a className="wtitle mono" href={prUrl(a)} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
        <span className="held">
          <St kind="warn">{checkWords(a.failed)}</St>
        </span>
        <span className="muted">{a.why}</span>
        {a.visual && <VisualLook visual={a.visual} />}
        <span className="wmeta">{a.namespace} · waiting {age(ms(a.at), now)}</span>
      </div>
      <div className="wact">
        {canApprove(a) && (
          <button type="button" className="btn primary" aria-label={`Approve ${name}`} onClick={() => confirm(approveRequest(a))}>
            Approve
          </button>
        )}
        <button type="button" className="btn" aria-label={`Close ${name}`} onClick={() => confirm(closeRequest(a))}>
          Close
        </button>
        {!canApprove(a) && <span className="faint wnote">{a.class === "typed" ? "Approve it by typing its number in chat." : "Not approvable here."}</span>}
      </div>
    </li>
  );
}

// What a visual pull request shows before Dustin approves it (src/visual-pr.ts,
// job_0368576da167): its live preview and its screenshots, read from the pull request. They
// open in a new tab as links, since the Portal's CSP loads no image from another origin.
function VisualLook({ visual }: { visual: NonNullable<OpsAwaitingSeat["visual"]> }) {
  return (
    <span className="visual-look">
      <span>{visual.title}</span>
      {visual.preview && (
        <a href={visual.preview} target="_blank" rel="noopener noreferrer">
          Open the preview
        </a>
      )}
      {visual.shots.map((src, i) => (
        <a key={src} href={src} target="_blank" rel="noopener noreferrer">
          Screenshot {i + 1}
        </a>
      ))}
      {!visual.preview && !visual.shots.length && <span className="faint">The pull request names no preview or screenshots; open it on GitHub.</span>}
    </span>
  );
}
