import { Suspense, lazy, type ReactNode } from "react";
import { Link } from "../lib/router";
import { arrange } from "capsomer/behavior/attention-list";
import { HEALTH_TABS, tabOf, useApp, type HealthTab } from "../app/ctx";
import { WAITING_KINDS, attentionList, siteScripts } from "../lib/derive";
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
  const { feed, now, open, href } = useApp();
  const { items, groups } = attentionList(feed, now, href, WAITING_KINDS);
  // Every problem, none held back behind "more": the verdict names the first few itself.
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
      okNote="Sites, backups and default branches were fine on the last pass."
      named={NAMED}
      more={(rest) => (
        <button type="button" className="cap-link-btn" onClick={() => open("view:needs#attention")}>
          {rest} more
        </button>
      )}
    />
  );
}
