import { useEffect, useState } from "react";
import { Spinner } from "capsomer/react/empty";
import { useLocation, useSearch } from "wouter";
import { useApp } from "../app/ctx";
import { fetchClaimsAggregate, fetchClaimsJob, type Answer } from "../lib/api";
import type { Kind } from "../lib/derive";
import { age, ago, ms, utc } from "../lib/format";
import type { ClaimsAgreement, ClaimsAgreementCounts, ClaimsGroup, JobClaimRow, JobEvaluationRow, PortalClaimsAggregate, PortalClaimsJob } from "../types";
import { St } from "../ui/icons";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

interface Load<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const AGREEMENTS: readonly ClaimsAgreement[] = ["agree", "disagree", "unclaimed", "unchecked"];

// agree and disagree are findings about the agent; unclaimed means it said nothing, and
// unchecked means the Worker could not verify what it said. Neither of those is a pass.
const AGREEMENT_KIND: Record<ClaimsAgreement, Kind> = { agree: "ok", disagree: "crit", unclaimed: "nodata", unchecked: "warn" };

const FILTER_KEYS = ["namespace", "agent", "since", "until"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filter = Record<FilterKey, string>;

function None({ what = "none" }: { what?: string }) {
  return <span className="faint">{what}</span>;
}

function message<T>(r: Answer<T>): string {
  if (r.kind === "refused") return `HTTP ${r.status}: ${r.message}`;
  if (r.kind === "expired" || r.kind === "error") return r.message;
  return "";
}

// A wait in milliseconds as "3.2h". Null is no wait measured, never zero.
function wait(msValue: number | null) {
  return msValue === null ? <None what="no wait" /> : <span className="num">{age(0, msValue)}</span>;
}

function totals(group: ClaimsGroup): ClaimsAgreementCounts {
  const out: ClaimsAgreementCounts = { agree: 0, disagree: 0, unclaimed: 0, unchecked: 0 };
  for (const counts of Object.values(group.evaluations)) for (const a of AGREEMENTS) out[a] += counts[a];
  return out;
}

function byCheck(groups: ClaimsGroup[]): Array<[string, ClaimsAgreementCounts]> {
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

function counts(record: Record<string, number>): string {
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

function AgreementCounts({ c }: { c: ClaimsAgreementCounts }) {
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

function JobDetail({ data, now }: { data: PortalClaimsJob; now: number }) {
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

// The filters and the open job live in the address (?namespace=&agent=&since=&until=&job=),
// so a view can be reloaded or shared. The inputs apply on submit.
export function Claims() {
  const { feed, now, signOut } = useApp();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const filter: Filter = { namespace: params.get("namespace") ?? "", agent: params.get("agent") ?? "", since: params.get("since") ?? "", until: params.get("until") ?? "" };
  const job = params.get("job") ?? "";
  const [input, setInput] = useState<Filter>(filter);
  const [jobInput, setJobInput] = useState(job);
  const [agg, setAgg] = useState<Load<PortalClaimsAggregate>>({ data: null, loading: true, error: null });
  const [detail, setDetail] = useState<Load<PortalClaimsJob>>({ data: null, loading: false, error: null });
  const [tick, setTick] = useState(0);
  const key = FILTER_KEYS.map((k) => filter[k]).join("\u0000");

  useEffect(() => {
    setInput({ ...filter });
    setJobInput(job);
  }, [key, job]);

  useEffect(() => {
    let alive = true;
    setAgg((l) => ({ ...l, loading: true }));
    void fetchClaimsAggregate(filter).then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setAgg({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      setAgg((l) => ({ ...l, loading: false, error: message(r) }));
    });
    return () => {
      alive = false;
    };
  }, [key, tick, signOut]);

  useEffect(() => {
    if (!job) return setDetail({ data: null, loading: false, error: null });
    let alive = true;
    setDetail({ data: null, loading: true, error: null });
    void fetchClaimsJob(job).then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setDetail({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      setDetail({ data: null, loading: false, error: message(r) });
    });
    return () => {
      alive = false;
    };
  }, [job, tick, signOut]);

  const go = (next: Filter, nextJob: string) => {
    const qs = new URLSearchParams();
    for (const k of FILTER_KEYS) if (next[k].trim()) qs.set(k, next[k].trim());
    if (nextJob.trim()) qs.set("job", nextJob.trim());
    const s = qs.toString();
    navigate(s ? `/claims?${s}` : "/claims", { replace: true });
  };

  const data = agg.data;
  const names = feed.live.namespaces.map((n) => n.name);
  if (filter.namespace && !names.includes(filter.namespace)) names.push(filter.namespace);
  const filtered = FILTER_KEYS.some((k) => filter[k]);
  const checks = data ? byCheck(data.groups) : [];

  return (
    <div className="page">
      <PageHead title="Claims" />
      <form
        className="toolbar"
        role="search"
        aria-label="Filter claims"
        onSubmit={(e) => {
          e.preventDefault();
          go(input, job);
        }}
      >
        <label className="sr-only" htmlFor="clNs">
          Namespace
        </label>
        <select id="clNs" className="search" value={input.namespace} onChange={(e) => setInput({ ...input, namespace: e.target.value })}>
          <option value="">All namespaces</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="clAgent">
          Agent
        </label>
        <input id="clAgent" className="search" type="search" placeholder="Agent, e.g. agent:sample-driver" value={input.agent} onChange={(e) => setInput({ ...input, agent: e.target.value })} />
        <label className="sr-only" htmlFor="clSince">
          Since
        </label>
        <input id="clSince" className="search" type="date" title="Since (inclusive)" value={input.since} onChange={(e) => setInput({ ...input, since: e.target.value })} />
        <label className="sr-only" htmlFor="clUntil">
          Before
        </label>
        <input id="clUntil" className="search" type="date" title="Before (exclusive)" value={input.until} onChange={(e) => setInput({ ...input, until: e.target.value })} />
        <button type="submit" className="btn">
          Apply
        </button>
        {filtered && (
          <button type="button" className="btn" onClick={() => go({ namespace: "", agent: "", since: "", until: "" }, job)}>
            Clear
          </button>
        )}
      </form>
      {agg.error && (
        <div className="callout crit" role="alert">
          Could not read the claims: {agg.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      {data && data.truncated.length > 0 && (
        <div className="callout warn" role="status">
          This read hit its bound on: {data.truncated.join(", ")}. Narrow the filter, or read every row through the claims tool's export.
        </div>
      )}
      <Panel
        flush
        title="By agent"
        count={data?.groups.length}
        src={
          <>
            {data ? `read ${ago(ms(data.generated), now)} · ` : ""}
            <button type="button" className="btn" disabled={agg.loading} onClick={() => setTick((t) => t + 1)}>
              {agg.loading ? "Reading..." : "Read again"}
            </button>
          </>
        }
      >
        {!data && agg.loading ? (
          <div className="loading" role="status">
            <Spinner label="Reading the claims..." />
          </div>
        ) : data && data.groups.length ? (
          <div className="scroll-x reflow">
            <table className="list cards-below-1100">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Namespace</th>
                  <th>Jobs</th>
                  <th>Claims</th>
                  <th>Checks</th>
                  <th>Touches</th>
                  <th>Median wait</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={`${g.agent ?? ""}\u0000${g.namespace}`} data-row="">
                    <td className="mono wrap" data-label="Agent">
                      {g.agent ?? <None what="no claim yet" />}
                    </td>
                    <td className="mono" data-label="Namespace">
                      {g.namespace}
                    </td>
                    <td className="num" data-label="Jobs">
                      {g.jobs}
                    </td>
                    <td className="num" data-label="Claims">
                      {g.claims}
                    </td>
                    <td data-label="Checks">
                      <AgreementCounts c={totals(g)} />
                    </td>
                    <td className="mono wrap" data-label="Touches">
                      {g.touches.count ? `${g.touches.count}: ${counts(g.touches.by_kind)}` : <None />}
                      {g.touches.count > 0 && <div className="src">{counts(g.touches.by_actor_kind)}</div>}
                    </td>
                    <td data-label="Median wait">
                      {wait(g.touches.waited_ms_median)}
                      {g.touches.waited_ms_total !== null && <div className="src">total {age(0, g.touches.waited_ms_total)} over {g.touches.waits}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="body faint">{filtered ? "No claims match these filters." : "No claim has been recorded yet."}</div>
        ) : (
          <div className="body faint">No read yet.</div>
        )}
      </Panel>
      {checks.length > 0 && (
        <Panel flush title="By check" count={checks.length} src="every agent above, summed">
          <div className="scroll-x reflow">
            <table className="list cards-below-1100">
              <thead>
                <tr>
                  <th>Check</th>
                  {AGREEMENTS.map((a) => (
                    <th key={a}>{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {checks.map(([name, c]) => (
                  <tr key={name} data-row="">
                    <td className="mono" data-label="Check">
                      {name}
                    </td>
                    {AGREEMENTS.map((a) => (
                      <td key={a} className="num" data-label={a}>
                        {c[a]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      <form
        className="toolbar"
        aria-label="Open a job"
        onSubmit={(e) => {
          e.preventDefault();
          go(filter, jobInput);
        }}
      >
        <label className="sr-only" htmlFor="clJob">
          Job id
        </label>
        <input id="clJob" className="search" type="search" list="clJobs" placeholder="Job id, e.g. job_0123456789ab" value={jobInput} onChange={(e) => setJobInput(e.target.value)} />
        <datalist id="clJobs">
          {feed.live.jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.namespace} · {j.title}
            </option>
          ))}
        </datalist>
        <button type="submit" className="btn">
          Open job
        </button>
        {job && (
          <button type="button" className="btn" onClick={() => go(filter, "")}>
            Close job
          </button>
        )}
      </form>
      {detail.loading && (
        <div className="loading" role="status">
          <Spinner label="Reading the job..." />
        </div>
      )}
      {detail.error && (
        <div className="callout crit" role="alert">
          Could not read job {job}: {detail.error}
        </div>
      )}
      {detail.data && <JobDetail data={detail.data} now={now} />}
    </div>
  );
}
