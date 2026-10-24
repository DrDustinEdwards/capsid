import type { Kind } from "../lib/derive";
import { age, utc, ms, ago } from "../lib/format";
import type { ClaimsGroup, ClaimsAgreementCounts, JobClaimRow, ClaimsAgreement, JobEvaluationRow, PortalClaimsJob } from "../types";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";

export const AGREEMENTS: readonly ClaimsAgreement[] = ["agree", "disagree", "unclaimed", "unchecked"];

// agree and disagree are findings about the agent; unclaimed means it said nothing, and
// unchecked means the Worker could not verify what it said. Neither of those is a pass.
const AGREEMENT_KIND: Record<ClaimsAgreement, Kind> = { agree: "ok", disagree: "crit", unclaimed: "nodata", unchecked: "warn" };

export function None({ what = "none" }: { what?: string }) {
  return <span className="faint">{what}</span>;
}

// A wait in milliseconds as "3.2h". Null is no wait measured, never zero.
export function wait(msValue: number | null) {
  return msValue === null ? <None what="no wait" /> : <span className="num">{age(0, msValue)}</span>;
}

export function totals(group: ClaimsGroup): ClaimsAgreementCounts {
  const out: ClaimsAgreementCounts = { agree: 0, disagree: 0, unclaimed: 0, unchecked: 0 };
  for (const counts of Object.values(group.evaluations)) for (const a of AGREEMENTS) out[a] += counts[a];
  return out;
}

export function byCheck(groups: ClaimsGroup[]): Array<[string, ClaimsAgreementCounts]> {
  const out = new Map<string, ClaimsAgreementCounts>();
  for (const g of groups) {
    for (const [name, counts] of Object.entries(g.evaluations)) {
      const sum = out.get(name) ?? { agree: 0, disagree: 0, unclaimed: 0, unchecked: 0 };
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
  return [c.model_id, c.client_name && `${c.client_name}${c.client_version ? ` ${c.client_version}` : ""}`, c.permission_mode].filter(Boolean).join(" · ");
}

function Agreement({ a }: { a: ClaimsAgreement }) {
  return <St kind={AGREEMENT_KIND[a]}>{a}</St>;
}

export function AgreementCounts({ c }: { c: ClaimsAgreementCounts }) {
  const parts = AGREEMENTS.filter((a) => c[a] > 0);
  if (parts.length === 0) return <None what="no checks" />;
  return (
    <span className="mono">
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
          <td className="mono" data-label="Check">
            {e.name}
          </td>
          <td className="mono wrap" data-label="Claimed">
            {e.claimed ?? <None what="not stated" />}
          </td>
          <td className="mono wrap" data-label="Verified">
            {e.verified ?? <None what="not checked" />}
          </td>
          <td data-label="Agreement">
            <Agreement a={e.agreement} />
          </td>
          <td className="num" data-label="Score">
            {e.score_label}
            {e.score_value !== null ? ` (${e.score_value})` : ""}
          </td>
          <td className="mono wrap" data-label="By">
            {e.evaluator_id}
          </td>
        </tr>
      ))}
    </>
  );
}

export function JobDetail({ data, now }: { data: PortalClaimsJob; now: number }) {
  const { job } = data;
  const orphans = data.evaluations.filter((e) => e.claim_id === null || !data.claims.some((c) => c.id === e.claim_id));
  return (
    <>
      <Panel flush title={`Job ${job.id}`} src={`${job.namespace} · ${job.status}${job.claimed_by ? ` · held by ${job.claimed_by}` : ""}`}>
        <div className="body">
          <p>{job.title}</p>
          {data.truncated.length > 0 && (
            <div className="callout warn" role="status">
              Cut at {data.limit} rows each: {data.truncated.join(", ")}. The tool's export reads every row.
            </div>
          )}
          {data.outcome === null && <p className="faint">No outcome recorded: the job has not completed or failed.</p>}
        </div>
      </Panel>
      <Panel flush title="Claim against verified" count={data.claims.length} src="each claim as the agent sent it, and each check the Worker ran on it">
        {data.claims.length === 0 ? (
          <div className="body faint">No claim recorded for this job: it has not reached complete, fail or block since claims were recorded.</div>
        ) : (
          data.claims.map((c) => {
            const checks = data.evaluations.filter((e) => e.claim_id === c.id);
            const said = stated(c);
            const v = versions(c);
            return (
              <div key={c.id} className="claim" data-claim={c.id}>
                <div className="body">
                  <dl className="kv">
                    <dt>Claim</dt>
                    <dd className="mono">
                      #{c.id} · {c.action} · {c.agent} · <span title={utc(ms(c.recorded_at))}>{ago(ms(c.recorded_at), now)}</span>
                    </dd>
                    <dt>Stated</dt>
                    <dd className="mono">{said.length ? said.join(" · ") : <None what="no structured claim" />}</dd>
                    <dt>Versions</dt>
                    <dd className="mono">{v || <None what="not stated" />}</dd>
                    <dt>Worker</dt>
                    <dd className="mono">{c.capsid_sha ?? <None what="unknown build" />}</dd>
                  </dl>
                </div>
                {checks.length ? (
                  <div className="scroll-x reflow">
                    <table className="list cards-below-1100">
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
                  <div className="body faint">{c.action === "block" ? "A block is a claim with no check: nothing is verified until the job ends." : "No check recorded for this claim."}</div>
                )}
              </div>
            );
          })
        )}
        {orphans.length > 0 && (
          <div className="scroll-x reflow">
            <table className="list cards-below-1100" aria-label="Checks with no claim">
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
      <Panel flush title="Touch log" count={data.touches.length} src="every time a human, or a policy acting for one, touched this job, oldest first">
        {data.touches.length === 0 ? (
          <div className="body faint">No touch recorded: nobody gated, resumed, released or reviewed this job.</div>
        ) : (
          <div className="scroll-x reflow">
            <table className="list cards-below-1100">
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
                    <td className="num" data-label="When" title={utc(ms(t.at))}>
                      {ago(ms(t.at), now)}
                    </td>
                    <td className="mono" data-label="Kind">
                      {t.kind}
                    </td>
                    <td className="mono wrap" data-label="Actor">
                      {t.actor} <span className="faint">({t.actor_kind})</span>
                    </td>
                    <td data-label="Waited">{wait(t.waited_ms)}</td>
                    <td className="mono wrap" data-label="Detail">
                      {t.detail ?? <None />}
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
