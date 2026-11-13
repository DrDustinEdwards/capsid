import { Alert, Banner } from "capsomer/react/banner";
import { trendChart } from "./charts";
import { FILTER_KEYS } from "../lib/keys";
import { Suspense, useState, type FormEvent } from "react";
import { FilterBar, isFiltered, withParams } from "capsomer/react/filter-bar";
import { Missing, Spinner } from "capsomer/react/empty";
import { Link, useLocation, useSearch } from "../lib/router";
import { useApp } from "../app/ctx";
import { fetchClaimsAggregate, fetchClaimsJob, useAnswer } from "../lib/api";
import { age, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { toCsv } from "@dustinedwards/site-runtime/csv";
import { downloadCsv } from "@dustinedwards/site-runtime/csv-client";
import type { PortalClaimsAggregate, PortalClaimsJob } from "../types";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { byCheck, AgreementCounts, totals, counts, wait, JobDetail, AGREEMENTS } from "./ClaimsJob";

// Chart 5, claim against verified per agent, is Enarratio's grouped bar chart, in the same
// lazy chunk as the Portal's other charts.
const AgreementChart = trendChart("AgreementChart");

type FilterKey = (typeof FILTER_KEYS)[number];
type Filter = Record<FilterKey, string>;

// The filters and the open job live in the address (?namespace=&agent=&since=&until=&job=),
// so a view can be reloaded or shared. The inputs apply on submit.
export function Claims() {
  const { feed, now } = useApp();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const filter: Filter = {
    namespace: params.get("namespace") ?? "",
    agent: params.get("agent") ?? "",
    since: params.get("since") ?? "",
    until: params.get("until") ?? "",
  };
  const job = params.get("job") ?? "";
  const [jobInput, setJobInput] = useState(job);
  const key = FILTER_KEYS.map((k) => filter[k]).join("\u0000");

  // The address changed: the job field follows it. Adjusted while rendering, not in an effect.
  const [seen, setSeen] = useState({ key, job });
  if (seen.key !== key || seen.job !== job) {
    setSeen({ key, job });
    setJobInput(job);
  }

  const agg = useAnswer<PortalClaimsAggregate>(["claims", key], () => fetchClaimsAggregate(filter));
  const detail = useAnswer<PortalClaimsJob>(["claims", "job", job], () => fetchClaimsJob(job), {
    keep: false,
    enabled: job !== "",
  });

  const go = (next: Filter, nextJob: string) => {
    // Checks is Jobs' tab, so the tab stays in the address beside the filter.
    navigate(withParams("/queue", { tab: "checks", ...next, job: nextJob }), { replace: true });
  };
  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = { ...filter };
    for (const k of FILTER_KEYS) next[k] = String(form.get(k) ?? "");
    go(next, job);
  };

  const data = agg.data;
  const names = feed.live.namespaces.map((n) => n.name);
  if (filter.namespace && !names.includes(filter.namespace)) names.push(filter.namespace);
  const filtered = isFiltered(filter, FILTER_KEYS);
  const checks = data ? byCheck(data.groups) : [];

  return (
    <div className="embedded">
      {/* The address changed (back, a link): the fields follow it, so the bar starts over. */}
      <FilterBar
        key={key}
        label="Filter claims"
        onSubmit={apply}
        clearLabel="Clear"
        clearHref={filtered ? withParams("/queue", { tab: "checks", job }) : null}
        renderLink={(props) => <Link {...props} />}
      >
        <label className="cap-sr-only" htmlFor="clNs">
          Project
        </label>
        <select id="clNs" className="search" name="namespace" defaultValue={filter.namespace}>
          <option value="">All projects</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label className="cap-sr-only" htmlFor="clAgent">
          Agent
        </label>
        <input
          id="clAgent"
          className="search"
          type="search"
          name="agent"
          placeholder="Agent, e.g. agent:sample-driver"
          defaultValue={filter.agent}
        />
        <label className="cap-sr-only" htmlFor="clSince">
          Since
        </label>
        <input
          id="clSince"
          className="search"
          type="date"
          name="since"
          title="Since (inclusive)"
          defaultValue={filter.since}
        />
        <label className="cap-sr-only" htmlFor="clUntil">
          Before
        </label>
        <input
          id="clUntil"
          className="search"
          type="date"
          name="until"
          title="Before (exclusive)"
          defaultValue={filter.until}
        />
      </FilterBar>
      {agg.error && (
        <Banner tone="crit">
          Could not read the claims: {agg.error}
          {data ? `. Showing the read from ${ago(parse(data.generated), now)}.` : ""}
        </Banner>
      )}
      {data && data.truncated.length > 0 && (
        <Banner tone="warn">
          This read hit its bound on: {data.truncated.join(", ")}. Narrow the filter, or read every
          row through the claims tool's export.
        </Banner>
      )}
      {data && <ClaimsExport data={data} />}
      <Panel
        flush
        title="By agent"
        count={data?.groups.length}
        src={
          <ReadAgain
            at={data ? parse(data.generated) : undefined}
            now={now}
            reading={agg.loading}
            onRead={() => {
              agg.reread();
              if (job) detail.reread();
            }}
          />
        }
      >
        {!data && agg.loading ? (
          <div className="loading" role="status">
            <Spinner label="Reading the claims..." />
          </div>
        ) : data && data.groups.length ? (
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table">
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
                    <td className="cap-mono wrap" data-label="Agent">
                      {g.agent ?? <Missing>no claim yet</Missing>}
                    </td>
                    <td className="cap-mono" data-label="Project">
                      {g.namespace}
                    </td>
                    <td className="cap-num" data-label="Jobs">
                      {g.jobs}
                    </td>
                    <td className="cap-num" data-label="Claims">
                      {g.claims}
                    </td>
                    <td data-label="Checks">
                      <AgreementCounts c={totals(g)} />
                    </td>
                    <td className="cap-mono wrap" data-label="Touches">
                      {g.touches.count ? (
                        `${g.touches.count}: ${counts(g.touches.by_kind)}`
                      ) : (
                        <Missing />
                      )}
                      {g.touches.count > 0 && (
                        <div className="src">{counts(g.touches.by_actor_kind)}</div>
                      )}
                    </td>
                    <td data-label="Median wait">
                      {wait(g.touches.waited_ms_median)}
                      {g.touches.waited_ms_total !== null && (
                        <div className="src">
                          total {age(0, g.touches.waited_ms_total)} over {g.touches.waits}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="cap-text body" data-tone="dim">
            {filtered ? "No claims match these filters." : "No claim has been recorded yet."}
          </div>
        ) : (
          <div className="cap-text body" data-tone="dim">
            No read yet.
          </div>
        )}
      </Panel>
      {data && data.groups.length > 0 && (
        <Suspense fallback={null}>
          <AgreementChart groups={data.groups} />
        </Suspense>
      )}
      {checks.length > 0 && (
        <Panel flush title="By check" count={checks.length} src="every agent above, summed">
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table">
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
                    <td className="cap-mono" data-label="Check">
                      {name}
                    </td>
                    {AGREEMENTS.map((a) => (
                      <td key={a} className="cap-num" data-label={a}>
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
        <label className="cap-sr-only" htmlFor="clJob">
          Job id
        </label>
        <input
          id="clJob"
          className="search"
          type="search"
          list="clJobs"
          placeholder="Job id, e.g. job_0123456789ab"
          value={jobInput}
          onChange={(e) => setJobInput(e.target.value)}
        />
        <datalist id="clJobs">
          {feed.live.jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.namespace} · {j.title}
            </option>
          ))}
        </datalist>
        <button type="submit" className="cap-btn">
          Open job
        </button>
        {job && (
          <button type="button" className="cap-btn" onClick={() => go(filter, "")}>
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
        <Alert tone="crit">
          Could not read job {job}: {detail.error}
        </Alert>
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
    downloadCsv(
      `claims-by-agent-${stamp}${cut}.csv`,
      toCsv(
        [
          "agent",
          "namespace",
          "jobs",
          "claims",
          ...checks.flatMap((c) => [
            `${c}_agree`,
            `${c}_disagree`,
            `${c}_unclaimed`,
            `${c}_unchecked`,
          ]),
          "touches",
          "waits",
          "waited_ms_total",
          "waited_ms_median",
        ],
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
    downloadCsv(
      `claims-waits-${stamp}${cut}.csv`,
      toCsv(
        ["namespace", "gate_class", "ended_by", "waits", "waited_ms_total", "waited_ms_median"],
        data.waits.map((w) => [
          w.namespace,
          w.gate_class,
          w.ended_by,
          w.waits,
          w.waited_ms_total,
          w.waited_ms_median,
        ]),
      ),
    );
  const usage = () => {
    const cols = [
      "rows",
      "cost_usd",
      "active_seconds",
      "tokens_input",
      "tokens_output",
      "tokens_cache_read",
      "tokens_cache_creation",
    ] as const;
    downloadCsv(
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
      <span className="cap-text hint" data-tone="dim" data-size="small">
        Export as CSV:
      </span>
      <button type="button" className="cap-btn" onClick={agents}>
        By agent
      </button>
      <button type="button" className="cap-btn" onClick={waits}>
        Waits
      </button>
      <button type="button" className="cap-btn" onClick={usage}>
        Usage
      </button>
    </div>
  );
}
