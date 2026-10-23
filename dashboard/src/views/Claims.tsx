import { Suspense, lazy, useEffect, useState } from "react";
import { Spinner } from "capsomer/react/empty";
import { useLocation, useSearch } from "wouter";
import { useApp } from "../app/ctx";
import { fetchClaimsAggregate, fetchClaimsJob } from "../lib/api";
import { age, ago, ms } from "../lib/format";
import { download, toCsv } from "../lib/csv";
import type { PortalClaimsAggregate, PortalClaimsJob } from "../types";
import { Panel } from "capsomer/react/panel";
import { PageHead, useAnswer } from "./shared";
import { message, byCheck, None, AgreementCounts, totals, counts, wait, JobDetail, AGREEMENTS } from "./ClaimsJob";

// Chart 5, claim against verified per agent, is Enarratio's grouped bar chart, in the same
// lazy chunk as the Portal's other charts.
const AgreementChart = lazy(() => import("./TrendCharts").then((m) => ({ default: m.AgreementChart })));

interface Load<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const FILTER_KEYS = ["namespace", "agent", "since", "until"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filter = Record<FilterKey, string>;

// The filters and the open job live in the address (?namespace=&agent=&since=&until=&job=),
// so a view can be reloaded or shared. The inputs apply on submit.
export function Claims({ embedded = false }: { embedded?: boolean } = {}) {
  const { feed, now, signOut } = useApp();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const filter: Filter = { namespace: params.get("namespace") ?? "", agent: params.get("agent") ?? "", since: params.get("since") ?? "", until: params.get("until") ?? "" };
  const job = params.get("job") ?? "";
  const [input, setInput] = useState<Filter>(filter);
  const [jobInput, setJobInput] = useState(job);
  const [detail, setDetail] = useState<Load<PortalClaimsJob>>({ data: null, loading: false, error: null });
  const [tick, setTick] = useState(0);
  const key = FILTER_KEYS.map((k) => filter[k]).join("\u0000");

  useEffect(() => {
    setInput({ ...filter });
    setJobInput(job);
  }, [key, job]);

  const agg = useAnswer<PortalClaimsAggregate>(() => fetchClaimsAggregate(filter), [key, tick]);

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
    // Claims is Agents' tab, so the tab stays in the address beside the filter.
    const qs = new URLSearchParams({ tab: "claims" });
    for (const k of FILTER_KEYS) if (next[k].trim()) qs.set(k, next[k].trim());
    if (nextJob.trim()) qs.set("job", nextJob.trim());
    navigate(`/agents?${qs}`, { replace: true });
  };

  const data = agg.data;
  const names = feed.live.namespaces.map((n) => n.name);
  if (filter.namespace && !names.includes(filter.namespace)) names.push(filter.namespace);
  const filtered = FILTER_KEYS.some((k) => filter[k]);
  const checks = data ? byCheck(data.groups) : [];

  return (
    <div className={embedded ? "embedded" : "page"}>
      {!embedded && <PageHead title="Claims" />}
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
          Project
        </label>
        <select id="clNs" className="search" value={input.namespace} onChange={(e) => setInput({ ...input, namespace: e.target.value })}>
          <option value="">All projects</option>
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
      {data && <ClaimsExport data={data} />}
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
                  <th>Project</th>
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
                    <td className="mono" data-label="Project">
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
      {data && data.groups.length > 0 && (
        <Suspense fallback={null}>
          <AgreementChart groups={data.groups} />
        </Suspense>
      )}
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

// The export (design-portal-evaluation.md, DECIDE 3, "claims export with waits and
// usage"): the aggregate as shown, under the filter in force, as three CSV files, one per
// table. Nothing is read again; a read that hit its bound says so in the file's name.
function ClaimsExport({ data }: { data: PortalClaimsAggregate }) {
  const stamp = data.generated.slice(0, 10);
  const cut = data.truncated.length ? "-partial" : "";
  const checks = [...new Set(data.groups.flatMap((g) => Object.keys(g.evaluations)))].sort();
  const agents = () =>
    download(
      `claims-by-agent-${stamp}${cut}.csv`,
      toCsv(
        ["agent", "namespace", "jobs", "claims", ...checks.flatMap((c) => [`${c}_agree`, `${c}_disagree`, `${c}_unclaimed`, `${c}_unchecked`]), "touches", "waits", "waited_ms_total", "waited_ms_median"],
        data.groups.map((g) => [
          g.agent,
          g.namespace,
          g.jobs,
          g.claims,
          ...checks.flatMap((c) => {
            const e = g.evaluations[c];
            return e ? [e.agree, e.disagree, e.unclaimed, e.unchecked] : [null, null, null, null];
          }),
          g.touches.count,
          g.touches.waits,
          g.touches.waited_ms_total,
          g.touches.waited_ms_median,
        ]),
      ),
    );
  const waits = () =>
    download(
      `claims-waits-${stamp}${cut}.csv`,
      toCsv(["namespace", "gate_class", "ended_by", "waits", "waited_ms_total", "waited_ms_median"], data.waits.map((w) => [w.namespace, w.gate_class, w.ended_by, w.waits, w.waited_ms_total, w.waited_ms_median])),
    );
  const usage = () => {
    const cols = ["rows", "cost_usd", "active_seconds", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_creation"] as const;
    download(
      `claims-usage-${stamp}${cut}.csv`,
      toCsv(
        ["namespace", "source", ...cols],
        data.usage.flatMap((u) => [
          [u.namespace, "telemetry", ...cols.map((c) => u.telemetry[c])],
          [u.namespace, "reported", ...cols.map((c) => u.reported[c])],
        ]),
      ),
    );
  };
  return (
    <div className="toolbar" role="group" aria-label="Export">
      <span className="faint small">Export as CSV:</span>
      <button type="button" className="btn" onClick={agents}>
        By agent
      </button>
      <button type="button" className="btn" onClick={waits}>
        Waits
      </button>
      <button type="button" className="btn" onClick={usage}>
        Usage
      </button>
    </div>
  );
}
