import { Banner } from "capsomer/react/banner";
import { RowList } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import "capsomer/group.css";
import { AnchorBar } from "capsomer/react/anchor-bar";
import "capsomer/anchor-bar.css";
import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { Suspense, lazy } from "react";
import { Spinner } from "capsomer/react/skeleton";
import { QUEUE_TABS, tabOf, useApp } from "../app/ctx";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { LIVE, fetchStale } from "../lib/api";
import { useAnswer, type Load } from "capsomer/react/data";
import { KIND_STATUS, JOB } from "../lib/derive";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { OpsJob, PortalStale, StaleRule } from "../types";
import { Status } from "capsomer/react/status";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { FilterEmpty, JobRow, NsChips, PageHead, QueueRows, useNsFilter } from "./shared";
import { Tonight } from "./Overnight";

const QueueChart = trendChart("QueueChart");
const ProjectChart = trendChart("ProjectChart");

const STALE_RULE: Record<StaleRule, string> = {
  "prs-settled": "Pull requests settled",
  "steps-seen": "Manual steps seen",
  "resumed-not-completed": "Resumed, not finished",
  unchanged: "Unchanged 3 days",
};

type StaleLoad = Load<PortalStale>;

function useStale(): { load: StaleLoad; reread: () => void } {
  const load = useAnswer([LIVE, "stale"], fetchStale);
  return { load, reread: load.reread };
}

function StaleJobs({ load, reread }: { load: StaleLoad; reread: () => void }) {
  const { now } = useApp();
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
        <Spinner layout="page" label="Reading the stale jobs..." />
      ) : rows.length ? (
        <RowList label="Stuck jobs">
          {rows.map((j) => {
            const k = JOB[j.status as OpsJob["status"]] ?? {
              kind: "nodata" as const,
              label: j.status,
            };
            return (
              <JobRow
                key={j.id}
                job={j}
                status={<Status {...KIND_STATUS[k.kind]}>{k.label}</Status>}
                detail={j.reason}
                fact={STALE_RULE[j.rule]}
              />
            );
          })}
        </RowList>
      ) : data ? (
        <Empty
          kind="all-clear"
          title={ns === "all" ? "No job looks stuck." : `No job in ${ns} looks stuck.`}
        />
      ) : null}
    </Panel>
  );
}

const Claims = lazy(() => import("./Claims").then((m) => ({ default: m.Claims })));

export function Queue() {
  const tab = tabOf(QUEUE_TABS, useTabParam()) ?? QUEUE_TABS[0].id;
  if (tab === "checks") {
    return (
      <div className="cap-admin-page">
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
  // The list leaves out every job the panel holds; until the panel has read, or its read fails, the list shows every job.
  const stale = useStale();
  const inPanel = new Set(stale.load.data?.rows.map((r) => r.id) ?? []);
  return (
    <div className="cap-admin-page">
      <AnchorBar />
      <PageHead title="Jobs" />
      <PageTabs label="Jobs" path="/queue" tabs={QUEUE_TABS} current="jobs" />
      <div className="cap-cluster" data-gap="3">
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
      <div className="cap-panes" data-even data-gap="5">
        <Panel flush title="All jobs" id="jobs" section="All jobs">
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
      <ChartSlot>
        <QueueChart />
      </ChartSlot>
    </div>
  );
}
