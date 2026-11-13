import { Banner } from "capsomer/react/banner";
import { AnchorBar } from "capsomer/react/anchor-bar";
import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { Suspense, lazy } from "react";
import { Spinner } from "capsomer/react/empty";
import { QUEUE_TABS, tabOf, useApp } from "../app/ctx";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { LIVE, fetchStale, useAnswer, type Load } from "../lib/api";
import { JOB } from "../lib/derive";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { OpsJob, PortalStale, StaleRule } from "../types";
import { St } from "../ui/icons";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { FilterEmpty, NsChips, PageHead, QueueRows, useNsFilter } from "./shared";
import { Tonight } from "./Overnight";

// Chart 3, whether the queue is growing or draining, from GET /portal/api/trends. Lazy, so
// Enarratio's area chart stays out of the initial bundle.
const QueueChart = trendChart("QueueChart");
// The "By project" panel's stacked bars, from the same module.
const ProjectChart = trendChart("ProjectChart");

// What each stale rule is called in a row, the most actionable first, as the Worker
// orders them (src/stale-jobs.ts).
const STALE_RULE: Record<StaleRule, string> = {
  "prs-settled": "Pull requests settled",
  "steps-seen": "Manual steps seen",
  "resumed-not-completed": "Resumed, not finished",
  unchanged: "Unchanged 3 days",
};

type StaleLoad = Load<PortalStale>;

// The stale view (capsid/research/design-stale-jobs.md): GET /portal/api/stale, the same
// rows `jobs` list with stale: true returns. Read when the Queue opens and again with
// each feed, so a resume or a close performed from the drawer drops its row.
function useStale(): { load: StaleLoad; reread: () => void } {
  const load = useAnswer([LIVE, "stale"], fetchStale);
  return { load, reread: load.reread };
}

// The panel. A row opens the job's drawer, which holds the controls (Resume, Close as
// shipped and the rest); nothing here changes a job.
function StaleJobs({ load, reread }: { load: StaleLoad; reread: () => void }) {
  const { now } = useApp();
  // The Queue's namespace chips narrow these rows too.
  const [ns] = useNsFilter();
  const data = load.data;
  const rows = data ? data.rows.filter((j) => ns === "all" || j.namespace === ns) : [];
  return (
    <Panel
      flush
      title="Stuck jobs"
      id="stale-jobs"
      section="Stuck jobs"
      count={data ? rows.length : undefined}
      src={
        <ReadAgain
          at={data ? parse(data.generated) : undefined}
          now={now}
          reading={load.loading}
          onRead={reread}
        />
      }
    >
      {load.error && (
        <Banner tone="crit">
          Could not read the stale jobs: {load.error}
          {data ? `. Showing the read from ${ago(parse(data.generated), now)}.` : ""}
        </Banner>
      )}
      {data?.note && <Banner tone="warn">{data.note}</Banner>}
      {!data && load.loading ? (
        <div className="loading" role="status">
          <Spinner label="Reading the stale jobs..." />
        </div>
      ) : rows.length ? (
        rows.map((j) => {
          const k = JOB[j.status as OpsJob["status"]] ?? {
            kind: "nodata" as const,
            label: j.status,
          };
          return (
            <div
              className="qrow"
              key={j.id}
              data-row=""
              data-open={`job:${j.id}`}
              data-rule={j.rule}
              role="button"
              tabIndex={0}
            >
              <St kind={k.kind}>{k.label}</St>
              <div className="t">
                <b>{j.title}</b>
                <div className="why">{j.reason}</div>
              </div>
              <div className="m">
                <span className="ns">{j.namespace}</span>
                <br />
                {STALE_RULE[j.rule]}
              </div>
            </div>
          );
        })
      ) : data ? (
        <Empty
          kind="all-clear"
          title={ns === "all" ? "No job looks stuck." : `No job in ${ns} looks stuck.`}
        />
      ) : (
        <div className="cap-text body" data-tone="dim">
          No read yet.
        </div>
      )}
    </Panel>
  );
}

// The claim checks (the claims ledger: what each agent said beside what the Worker verified),
// Jobs' second tab since the Portal audit's new map (2026-11-06; it was Agents' Checks tab),
// loaded when the tab opens. The tab is in the address (?tab=checks), so it can be reloaded or
// shared with its filters.
const Claims = lazy(() => import("./Claims").then((m) => ({ default: m.Claims })));

export function Queue() {
  const tab = tabOf(QUEUE_TABS, useTabParam()) ?? QUEUE_TABS[0].id;
  if (tab === "checks") {
    return (
      <div className="page">
        <PageHead title="Jobs" />
        <PageTabs label="Jobs" path="/queue" tabs={QUEUE_TABS} current={tab} />
        <Suspense fallback={null}>
          <Claims />
        </Suspense>
      </div>
    );
  }
  return <JobsTab />;
}

function JobsTab() {
  const { feed, filters, setFilters } = useApp();
  const [ns, setNs] = useNsFilter();
  const all = feed.live.jobs;
  const q = filters.q.trim().toLowerCase();
  const jobs = all.filter(
    (j) =>
      (ns === "all" || j.namespace === ns) &&
      (!q || `${j.title} ${j.id} ${j.waits_on ?? ""} ${j.command ?? ""}`.toLowerCase().includes(q)),
  );
  const nss = [...new Set(all.map((j) => j.namespace))];
  // Stale jobs show in one place: the panel (Dustin, 2026-10-09, folding the list's old
  // "Stale, blocked over 7 days" group into it). The list leaves out every job the panel
  // holds; until the panel has read, or when its read fails, the list shows every job.
  const stale = useStale();
  const inPanel = new Set(stale.load.data?.rows.map((r) => r.id) ?? []);
  return (
    <div className="page">
      <AnchorBar />
      <PageHead title="Jobs" />
      <PageTabs label="Jobs" path="/queue" tabs={QUEUE_TABS} current="jobs" />
      <div className="toolbar">
        <NsChips list={nss} />
        <input
          className="search"
          id="qsearch"
          type="search"
          placeholder="Filter jobs (f)"
          value={filters.q}
          aria-label="Filter jobs"
          onChange={(e) => setFilters({ q: e.target.value })}
        />
      </div>
      <StaleJobs load={stale.load} reread={stale.reread} />
      <div className="grid2">
        <Panel
          flush
          title="All jobs"
          id="jobs"
          section="All jobs"
          src="live · D1 jobs, read on each refresh"
        >
          {!jobs.length && all.length ? (
            <FilterEmpty onShowAll={() => (setFilters({ q: "" }), setNs("all"))}>
              No job {q ? `matches the text "${filters.q.trim()}"` : "is listed"}
              {ns !== "all" ? ` in the project ${ns}` : ""}.
            </FilterEmpty>
          ) : (
            <QueueRows jobs={jobs.filter((j) => !inPanel.has(j.id))} />
          )}
        </Panel>
        <Panel flush title="By project" id="by-namespace" section="By project">
          <div className="body">
            <ChartSlot>
              <ProjectChart
                counts={nss.map((project) => {
                  const js = all.filter((j) => j.namespace === project);
                  const n = (status: OpsJob["status"]) =>
                    js.filter((j) => j.status === status).length;
                  return {
                    project,
                    blocked: n("blocked"),
                    running: n("claimed"),
                    queued: n("queued"),
                  };
                })}
              />
            </ChartSlot>
          </div>
        </Panel>
        <Tonight />
      </div>
      {/* The chart goes last: the lists are what a person comes for (the UX audit's m6). */}
      <ChartSlot>
        <QueueChart />
      </ChartSlot>
    </div>
  );
}
