import { Suspense, lazy, type ReactNode } from "react";
import { Link } from "../lib/router";
import { arrange } from "capsomer/behavior/attention-list";
import { HEALTH_TABS, tabOf, useApp, type HealthTab } from "../app/ctx";
import { attentionList, siteScripts } from "../lib/derive";
import { Verdict } from "capsomer/react/verdict";
import "capsomer/verdict.css";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Backups } from "./Backups";
import { DefaultBranches } from "./Ci";
import { Incidents, ScheduledTasks } from "./Incidents";
import { Overview } from "./Overview";
import { UnownedResources } from "./Workers";
import { PageHead } from "./shared";
import { useFigures } from "../lib/trends";
import { ChartSlot } from "../ui/ChartSlot";
import { boardChart } from "./charts";

const Maintenance = lazy(() => import("./Maintenance").then((m) => ({ default: m.Maintenance })));

const NAMED = 3;
const ServerFigure = boardChart("ServerFigure");

export function Health() {
  const tab: HealthTab = tabOf(HEALTH_TABS, useTabParam()) ?? HEALTH_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Health" />
      <HealthVerdict />
      <Overview />
      <PageTabs label="Health" path="/health" tabs={HEALTH_TABS} current={tab} />
      <div className="cap-stack" id={tab} data-tab-panel={tab}>
        <TabPanel tab={tab} />
      </div>
    </div>
  );
}

function TabPanel({ tab }: { tab: HealthTab }): ReactNode {
  const { feed } = useApp();
  switch (tab) {
    case "problems":
      return (
        <>
          <OpenProblems />
          <Incidents />
          <Suspense fallback={null}>
            <Maintenance />
          </Suspense>
        </>
      );
    case "backups":
      return <Backups />;
    case "ci":
      return <DefaultBranches />;
    case "scheduled":
      return <ScheduledTasks />;
    case "resources":
      return <UnownedResources siteScripts={siteScripts(feed)} />;
  }
}

function OpenProblems() {
  const d = useFigures("problems").data;
  if (!d?.figures.open) return null;
  return (
    <ChartSlot>
      <ServerFigure html={d.figures.open} />
    </ChartSlot>
  );
}

function HealthVerdict() {
  const { feed, now, open, href } = useApp();
  const { items, groups } = attentionList(feed, now, href);
  const { problems } = arrange(items, { groups, rows: Infinity });
  return (
    <Verdict
      problems={problems.map((p) =>
        p.kind === "row"
          ? {
              key: p.item.id,
              tone: p.item.tone === "crit" ? "crit" : "warn",
              label: <Link href={p.item.href}>{p.item.title}</Link>,
            }
          : {
              key: `group:${p.key}`,
              tone: p.tone === "crit" ? "crit" : "warn",
              label: <Link href={p.view?.href ?? p.items[0]!.href}>{p.label}</Link>,
            },
      )}
      named={NAMED}
      more={(rest) => (
        <button type="button" className="cap-link-btn" onClick={() => open("view:board#attention")}>
          {rest} more
        </button>
      )}
    />
  );
}
