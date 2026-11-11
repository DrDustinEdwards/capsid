import { Suspense, lazy, type ReactNode } from "react";
import { Link } from "../lib/router";
import { HEALTH_TABS, placePath, tabOf, useApp, type HealthTab } from "../app/ctx";
import { WAITING_KINDS, attentionGroups, siteScripts, type AttentionRow } from "../lib/derive";
import { Verdict } from "capsomer/react/verdict";
import "capsomer/verdict.css";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Backups } from "./Backups";
import { DefaultBranches } from "./Ci";
import { Incidents, ScheduledTasks } from "./Incidents";
import { Overview } from "./Overview";
import { UnownedResources } from "./Workers";
import { PageHead } from "./shared";

// HEALTH (docs/design/design-portal-evaluation.md section 2; the Portal audit's new map,
// 2026-11-06): "is anything broken" across everything, answered in one line first. Then the
// tiles, then one tab at a time: Problems (the watcher's findings and the maintenance pass's
// list), Backups, CI's default branches, Scheduled tasks, and Cloudflare (the Workers no site
// owns, and every store). Each site's own state is on its page under Sites. The tab is in the
// address (?tab=), so Back, a bookmark and an alert reach it; the one namespace filter (?ns=)
// narrows every tab and is kept when the tab changes.

const Maintenance = lazy(() => import("./Maintenance").then((m) => ({ default: m.Maintenance })));

// The problems the verdict names before it says "and N more".
const NAMED = 3;

export function Health() {
  const tab: HealthTab = tabOf(HEALTH_TABS, useTabParam()) ?? HEALTH_TABS[0].id;
  return (
    <div className="page">
      <PageHead title="Health" />
      <HealthVerdict />
      <Overview />
      <PageTabs label="Health" path="/health" tabs={HEALTH_TABS} current={tab} />
      <div className="embedded" id={tab} data-tab-panel={tab}>
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

// One line: "All good", or how many problems and the first few by name, each a link to
// where it is fixed (Capsomer's Verdict). The same problems as Needs you's list (what waits on
// you is not one of them: it is in Waiting for you), so the two pages never disagree.
function HealthVerdict() {
  const { feed, now, open } = useApp();
  const { problems } = attentionGroups(feed, now, WAITING_KINDS);
  return (
    <Verdict
      problems={problems.map((p) => ({
        key: p.key,
        tone: p.sev === "crit" ? "crit" : "warn",
        label: <ProblemLink row={p} />,
      }))}
      okNote="Sites, backups and default branches were fine on the last pass."
      named={NAMED}
      more={(rest) => (
        <button type="button" className="linkbtn" onClick={() => open("view:needs#attention")}>
          {rest} more
        </button>
      )}
    />
  );
}

// A problem names a page, a tab or a drawer; a group names the view that lists them all.
function ProblemLink({ row }: { row: AttentionRow }) {
  const { open } = useApp();
  const ref = row.view ? `view:${row.view.id}` : row.open;
  const to = ref.startsWith("view:") ? placePath(ref.slice(5)) : null;
  if (to && !to.includes("#")) return <Link href={to}>{row.title}</Link>;
  return (
    <button type="button" className="linkbtn" onClick={() => open(ref)}>
      {row.title}
    </button>
  );
}
