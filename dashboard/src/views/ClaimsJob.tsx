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

// agree and disagree are findings about the agent; unclaimed (said nothing) and unchecked (Worker could not verify) are not a pass.
const AGREEMENT_KIND: Record<ClaimsAgreement, Kind> = {
  agree: "ok",
  disagree: "crit",
  unclaimed: "nodata",
  unchecked: "warn",
};

// Null is no wait measured, never zero.
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

type Said = {
  evidence?: { prs?: unknown[]; commits?: number; files_changed?: number; tests_added?: number };
  claim?: {
    prs_opened?: unknown[];
    prs_merged?: unknown[];
    tests?: { run?: number; passed?: number; failed?: number; result?: string };
    deploy_state?: string;
    files_touched?: unknown[];
    versions?: {
      model_id?: string;
      client_name?: string;
      client_version?: string;
      permission_mode?: string;
    };
  };
};

// A row whose raw does not parse is shown as unreadable.
function saidOf(c: JobClaimRow): Said | string {
  try {
    return JSON.parse(c.raw) as Said;
  } catch (e) {
    return `unreadable (${e instanceof Error ? e.message : String(e)})`;
  }
}

function stated(c: JobClaimRow): string[] {
  const said = saidOf(c);
  if (typeof said === "string") return [said];
  const { evidence: e, claim: k } = said;
  const out: string[] = [];
  const add = (label: string, v: number | string | undefined) =>
    v !== undefined && out.push(`${label} ${v}`);
  add("PRs opened", (k?.prs_opened ?? e?.prs)?.length);
  add("PRs merged", k?.prs_merged?.length);
  add("commits", e?.commits);
  add("files changed", e?.files_changed);
  add("tests added", e?.tests_added);
  add("tests run", k?.tests?.run);
  add("passed", k?.tests?.passed);
  add("failed", k?.tests?.failed);
  add("tests", k?.tests?.result);
  add("deploy", k?.deploy_state);
  add("files touched", k?.files_touched?.length);
  return out;
}

function versions(c: JobClaimRow): string {
  const v = typeof saidOf(c) === "string" ? undefined : (saidOf(c) as Said).claim?.versions;
  return [
    v?.model_id,
    v?.client_name && `${v.client_name}${v.client_version ? ` ${v.client_version}` : ""}`,
    v?.permission_mode,
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

function EvaluationTable({ rows, label }: { rows: JobEvaluationRow[]; label?: string }) {
  return (
    <div className="cap-table-wrap" data-reflow="wide">
      <table className="cap-table" aria-label={label}>
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
        </tbody>
      </table>
    </div>
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
              No outcome recorded.
            </p>
          )}
        </div>
      </Panel>
      <Panel flush title="Claim against verified" count={data.claims.length}>
        {data.claims.length === 0 ? (
          <div className="cap-text body" data-tone="dim">
            No claim recorded.
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
                  <EvaluationTable rows={checks} />
                ) : c.action === "block" ? null : (
                  <div className="cap-text body" data-tone="dim">
                    No check recorded for this claim.
                  </div>
                )}
              </div>
            );
          })
        )}
        {orphans.length > 0 && <EvaluationTable rows={orphans} label="Checks with no claim" />}
      </Panel>
      <Panel flush title="Touch log" count={data.touches.length}>
        {data.touches.length === 0 ? (
          <div className="cap-text body" data-tone="dim">
            No touch recorded.
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
