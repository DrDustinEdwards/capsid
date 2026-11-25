import { AwayLink } from "capsomer/react/link";
import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { useApp } from "../app/ctx";
import { KIND_STATUS } from "../lib/derive";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import { Panel } from "capsomer/react/panel";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "./shared";
import { LIVE, fetchMergeUnits } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { UNIT_STATE, UnitButtons, resumeRequest, signPolicyRequest } from "./automerge";
import { unitRows } from "../lib/merge-units";

function prLabel(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]} #${m[2]}` : url;
}

const MergesChart = trendChart("MergesChart");

export function PullRequests() {
  const { feed, now, confirm } = useApp();
  const live = feed.live;
  return (
    <div className="cap-admin-page">
      <PageHead title="Pull requests" />
      <div className="cap-stack" id="auto-merge">
        <Panel title="Auto-merge policy">
          <div className="cap-stack" data-gap="4">
            {live.merge_policy.loads ? (
              <p>
                <Status tone="ok">Loads</Status> version {live.merge_policy.version},{" "}
                {live.merge_policy.enabled ? "enabled" : "disabled"}.
              </p>
            ) : (
              <>
                <p>
                  <Status tone="crit">Does not load</Status> Nothing is auto-merged until it does.
                </p>
                <p className="cap-muted prewrap">{live.merge_policy.reason}</p>
              </>
            )}
            <div className="cap-cluster" data-gap="3">
              <button type="button" className="cap-btn" onClick={() => confirm(signPolicyRequest)}>
                Load from repo and sign
              </button>
            </div>
          </div>
        </Panel>
        {live.merge_safety && (
          <Panel
            flush
            title="Auto-merge, last 7 days"
            id="merge-safety"
            count={live.merge_safety.namespaces.length}
          >
            <div className="cap-table-wrap" data-reflow="wide">
              <table className="cap-table">
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
                      <span className="cap-sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live.merge_safety.namespaces.map((n) => (
                    <tr key={n.namespace}>
                      <td className="nowrap">
                        <b>{n.namespace}</b>
                      </td>
                      <td className="cap-num" data-label="Auto">
                        {n.auto_merged}
                      </td>
                      <td className="cap-num" data-label="Approved">
                        {n.approved}
                      </td>
                      <td className="cap-num" data-label="Verified">
                        {n.deploys_verified}
                      </td>
                      <td className="cap-num" data-label="Rolled back">
                        {n.rolled_back}
                      </td>
                      <td className="cap-num" data-label="Rollback failed">
                        {n.rollback_failed}
                      </td>
                      <td className="cap-num" data-label="Reverts">
                        {n.reverts}
                      </td>
                      <td data-label="State">
                        {n.paused ? (
                          <Status tone="warn">Paused</Status>
                        ) : (
                          <span className="cap-text" data-tone="dim">
                            running
                          </span>
                        )}
                      </td>
                      {/* The reason wraps in its own cell: a status chip does not wrap. */}
                      <td className="cap-muted" data-label="Why">
                        {n.paused?.reason ?? ""}
                      </td>
                      <td>
                        {n.paused && (
                          <button
                            type="button"
                            className="cap-btn"
                            aria-label={`Resume auto-merge for ${n.namespace}`}
                            onClick={() => confirm(resumeRequest(n.namespace))}
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
      <Panel flush title="Pull requests, last 7 days" count={live.prs.length}>
        <div className="cap-table-wrap" data-reflow="wide">
          <table className="cap-table">
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
                  <tr
                    key={`${p.job_id}-${p.pr_url}`}
                    className={job ? "click" : undefined}
                    data-row=""
                    data-open={job ? `job:${job.id}` : undefined}
                    tabIndex={job ? 0 : undefined}
                  >
                    <td className="cap-mono">
                      <AwayLink href={p.pr_url} newTab>
                        {prLabel(p.pr_url)}
                      </AwayLink>
                    </td>
                    <td data-label="Job">
                      {job ? (
                        job.title
                      ) : (
                        <span className="cap-text cap-mono" data-tone="dim">
                          {p.job_id}
                        </span>
                      )}
                    </td>
                    <td data-label="State">
                      {p.merged === true ? (
                        <Status tone="ok">Merged</Status>
                      ) : p.merged === false ? (
                        <Status tone="crit">Not merged</Status>
                      ) : (
                        <Status tone="info" running>
                          Open
                        </Status>
                      )}
                    </td>
                    <td className="cap-num" data-label="Verified">
                      {p.merge_verified_at ? (
                        ago(parse(p.merge_verified_at), now)
                      ) : (
                        <span className="cap-text" data-tone="dim">
                          not yet
                        </span>
                      )}
                    </td>
                    <td className="cap-num" data-label="Recorded">
                      {ago(parse(p.recorded_at), now)}
                    </td>
                  </tr>
                );
              })}
              {!live.prs.length && (
                <tr>
                  <td colSpan={5} className="cap-text" data-tone="dim">
                    None in 7 days.
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
    </div>
  );
}

function MergeUnits() {
  const { feed } = useApp();
  const load = useAnswer([LIVE, "merge-units"], fetchMergeUnits);
  const policy = feed.live.merge_policy;
  const units = load.data;
  if (!policy.loads) return null;
  if (!units)
    return (
      <Panel title="Merge units" id="merge-units">
        <p className={load.error ? "prewrap" : "cap-muted"}>
          {load.error
            ? `The merge units could not be read: ${load.error}`
            : "Reading the merge units..."}
        </p>
      </Panel>
    );
  const rows = unitRows(policy.units, units);
  const suspended = new Set(units.suspended.map((s) => s.unit));
  return (
    <Panel
      flush
      title="Merge units"
      id="merge-units"
      count={rows.length}
      src={units.generated ? `judged ${utc(parse(units.generated))}` : "not judged yet"}
    >
      {rows.length ? (
        <div className="cap-table-wrap" data-reflow="wide">
          <table className="cap-table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>State</th>
                <th>Why</th>
                <th>
                  <span className="cap-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = UNIT_STATE[r.state];
                return (
                  <tr key={r.unit}>
                    <td className="cap-mono nowrap">{r.unit}</td>
                    <td data-label="State">
                      <Status {...KIND_STATUS[st.kind]}>{st.label}</Status>
                    </td>
                    <td className="cap-muted" data-label="Why">
                      {r.why}
                    </td>
                    <td>
                      <UnitButtons row={r} policy={policy} suspended={suspended.has(r.unit)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty kind="all-clear" title="No units." />
      )}
    </Panel>
  );
}
