import { Alert } from "capsomer/react/banner";
import type { Kind } from "../lib/derive";
import { age, ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type {
  ClaimsGroup,
  ClaimsAgreementCounts,
  JobClaimRow,
  ClaimsAgreement,
  JobEvaluationRow,
  PortalClaimsJob,
} from "../types";
import { Status } from "capsomer/react/status";
import { KIND_STATUS } from "../lib/derive";
import { Missing } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

export const AGREEMENTS: readonly ClaimsAgreement[] = [
  "agree",
  "disagree",
  "unclaimed",
  "unchecked",
];

// agree and disagree are findings about the agent; unclaimed means it said nothing, and
// unchecked means the Worker could not verify what it said. Neither of those is a pass.
const AGREEMENT_KIND: Record<ClaimsAgreement, Kind> = {
  agree: "ok",
  disagree: "crit",
  unclaimed: "nodata",
  unchecked: "warn",
};

// A wait in milliseconds as "3.2h". Null is no wait measured, never zero.
export function wait(msValue: number | null) {
  return msValue === null ? (
    <Missing>no wait</Missing>
  ) : (
    <span className="cap-num">{age(0, msValue)}</span>
  );
}

export function totals(group: ClaimsGroup): ClaimsAgreementCounts {
  const out: ClaimsAgreementCounts = {
    agree: 0,
    disagree: 0,
    unclaimed: 0,
    unchecked: 0,
  };
  for (const counts of Object.values(group.evaluations))
    for (const a of AGREEMENTS) out[a] += counts[a];
  return out;
}

export function byCheck(groups: ClaimsGroup[]): Array<[string, ClaimsAgreementCounts]> {
  const out = new Map<string, ClaimsAgreementCounts>();
  for (const g of groups) {
    for (const [name, counts] of Object.entries(g.evaluations)) {
      const sum = out.get(name) ?? {
        agree: 0,
        disagree: 0,
        unclaimed: 0,
        unchecked: 0,
      };
      for (const a of AGREEMENTS) sum[a] += counts[a];
      out.set(name, sum);
    }
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b));
}

export function counts(record: Record<string, number>): string {
  const entries = Object.entries(record).sort(([, a], [, b]) => b - a);
  return entries.length ? entries.map(([k, n]) => `${k} ${n}`).join(" · ") : "";
}

// What a claim row states, field by field, skipping what the agent did not state.
function stated(c: JobClaimRow): string[] {
  const out: string[] = [];
  const add = (label: string, v: number | string | null) => v !== null && out.push(`${label} ${v}`);
  add("PRs opened", c.prs_opened);
  add("PRs merged", c.prs_merged);
  add("commits", c.commits);
  add("files changed", c.files_changed);
  add("tests added", c.tests_added);
  add("tests run", c.tests_run);
  add("passed", c.tests_passed);
  add("failed", c.tests_failed);
  add("tests", c.tests_result);
  add("deploy", c.deploy_state);
  if (c.files_touched !== null) {
    let n: number | string = "?";
    try {
      const parsed: unknown = JSON.parse(c.files_touched);
      if (Array.isArray(parsed)) n = parsed.length;
    } catch (e) {
      // Stored by the Worker as JSON; a row that does not parse is shown as unreadable, and said so.
      n = `unreadable (${e instanceof Error ? e.message : String(e)})`;
    }
    out.push(`files touched ${n}`);
  }
  return out;
}

function versions(c: JobClaimRow): string {
  return [
    c.model_id,
    c.client_name && `${c.client_name}${c.client_version ? ` ${c.client_version}` : ""}`,
    c.permission_mode,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Agreement({ a }: { a: ClaimsAgreement }) {
  return <Status {...KIND_STATUS[AGREEMENT_KIND[a]]}>{a}</Status>;
}

export function AgreementCounts({ c }: { c: ClaimsAgreementCounts }) {
  const parts = AGREEMENTS.filter((a) => c[a] > 0);
  if (parts.length === 0) return <Missing>no checks</Missing>;
  return (
    <span className="cap-mono">
      {parts.map((a, i) => (
        <span key={a}>
          {i > 0 ? " · " : ""}
          {a} {c[a]}
        </span>
      ))}
    </span>
  );
}

function EvaluationRows({ rows }: { rows: JobEvaluationRow[] }) {
  return (
    <>
      {rows.map((e) => (
        <tr key={e.id} data-row="">
          <td className="cap-mono" data-label="Check">
            {e.name}
          </td>
          <td className="cap-mono wrap" data-label="Claimed">
            {e.claimed ?? <Missing>not stated</Missing>}
          </td>
          <td className="cap-mono wrap" data-label="Verified">
            {e.verified ?? <Missing>not checked</Missing>}
          </td>
          <td data-label="Agreement">
            <Agreement a={e.agreement} />
          </td>
          <td className="cap-num" data-label="Score">
            {e.score_label}
            {e.score_value !== null ? ` (${e.score_value})` : ""}
          </td>
          <td className="cap-mono wrap" data-label="By">
            {e.evaluator_id}
          </td>
        </tr>
      ))}
    </>
  );
}

export function JobDetail({ data, now }: { data: PortalClaimsJob; now: number }) {
  const { job } = data;
  const orphans = data.evaluations.filter(
    (e) => e.claim_id === null || !data.claims.some((c) => c.id === e.claim_id),
  );
  return (
    <>
      <Panel
        flush
        title={`Job ${job.id}`}
        src={`${job.namespace} · ${job.status}${job.claimed_by ? ` · held by ${job.claimed_by}` : ""}`}
      >
        <div className="body">
          <p>{job.title}</p>
          {data.truncated.length > 0 && (
            <Alert tone="warn">
              Cut at {data.limit} rows each: {data.truncated.join(", ")}. The tool's export reads
              every row.
            </Alert>
          )}
          {data.outcome === null && (
            <p className="cap-text" data-tone="dim">
              No outcome recorded: the job has not completed or failed.
            </p>
          )}
        </div>
      </Panel>
      <Panel
        flush
        title="Claim against verified"
        count={data.claims.length}
        src="each claim as the agent sent it, and each check the Worker ran on it"
      >
        {data.claims.length === 0 ? (
          <div className="cap-text body" data-tone="dim">
            No claim recorded for this job: it has not reached complete, fail or block since claims
            were recorded.
          </div>
        ) : (
          data.claims.map((c) => {
            const checks = data.evaluations.filter((e) => e.claim_id === c.id);
            const said = stated(c);
            const v = versions(c);
            return (
              <div key={c.id} className="claim" data-claim={c.id}>
                <div className="body">
                  <dl className="cap-detail-record">
                    <dt>Claim</dt>
                    <dd className="cap-mono">
                      #{c.id} · {c.action} · {c.agent} ·{" "}
                      <span title={utc(parse(c.recorded_at))}>
                        {ago(parse(c.recorded_at), now)}
                      </span>
                    </dd>
                    <dt>Stated</dt>
                    <dd className="cap-mono">
                      {said.length ? said.join(" · ") : <Missing>no structured claim</Missing>}
                    </dd>
                    <dt>Versions</dt>
                    <dd className="cap-mono">{v || <Missing>not stated</Missing>}</dd>
                    <dt>Worker</dt>
                    <dd className="cap-mono">{c.capsid_sha ?? <Missing>unknown build</Missing>}</dd>
                  </dl>
                </div>
                {checks.length ? (
                  <div className="cap-table-wrap" data-reflow="wide">
                    <table className="cap-table">
                      <thead>
                        <tr>
                          <th>Check</th>
                          <th>Claimed</th>
                          <th>Verified</th>
                          <th>Agreement</th>
                          <th>Score</th>
                          <th>By</th>
                        </tr>
                      </thead>
                      <tbody>
                        <EvaluationRows rows={checks} />
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="cap-text body" data-tone="dim">
                    {c.action === "block"
                      ? "A block is a claim with no check: nothing is verified until the job ends."
                      : "No check recorded for this claim."}
                  </div>
                )}
              </div>
            );
          })
        )}
        {orphans.length > 0 && (
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table" aria-label="Checks with no claim">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Claimed</th>
                  <th>Verified</th>
                  <th>Agreement</th>
                  <th>Score</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                <EvaluationRows rows={orphans} />
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel
        flush
        title="Touch log"
        count={data.touches.length}
        src="every time a human, or a policy acting for one, touched this job, oldest first"
      >
        {data.touches.length === 0 ? (
          <div className="cap-text body" data-tone="dim">
            No touch recorded: nobody gated, resumed, released or reviewed this job.
          </div>
        ) : (
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Actor</th>
                  <th>Waited</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.touches.map((t) => (
                  <tr key={t.id} data-row="">
                    <td className="cap-num" data-label="When" title={utc(parse(t.at))}>
                      {ago(parse(t.at), now)}
                    </td>
                    <td className="cap-mono" data-label="Kind">
                      {t.kind}
                    </td>
                    <td className="cap-mono wrap" data-label="Actor">
                      {t.actor}{" "}
                      <span className="cap-text" data-tone="dim">
                        ({t.actor_kind})
                      </span>
                    </td>
                    <td data-label="Waited">{wait(t.waited_ms)}</td>
                    <td className="cap-mono wrap" data-label="Detail">
                      {t.detail ?? <Missing />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
