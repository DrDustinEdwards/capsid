import { Suspense, lazy, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "wouter";
import { HEALTH_TABS, healthTab, placePath, useApp, type HealthTab } from "../app/ctx";
import { WAITING_KINDS, attentionGroups, hasSites, type AttentionRow } from "../lib/derive";
import { St } from "../ui/icons";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Backups } from "./Backups";
import { DefaultBranches } from "./Ci";
import { Deploys } from "./Deploys";
import { Incidents } from "./Incidents";
import { Overview } from "./Overview";
import { Sites } from "./Sites";
import { PageHead } from "./shared";

// HEALTH (docs/design/design-portal-evaluation.md section 2, DECIDE 2, ruled 2026-10-09;
// the UX audit's M1, 2026-10): "is anything broken", answered in one line first. Then the
// tiles, then one tab at a time: Sites (only while one is configured), Problems (the
// watcher's findings and the maintenance pass's list), Deploys, Backups and CI's default
// branches. The tab is in the address (?tab=), so Back, a bookmark and an alert reach it;
// the one namespace filter (?ns=) narrows every tab and is kept when the tab changes.

const Maintenance = lazy(() => import("./Maintenance").then((m) => ({ default: m.Maintenance })));

// The problems the verdict names before it says "and N more".
const NAMED = 3;

// The address's #fragment, followed as it changes.
const onHash = (cb: () => void) => (window.addEventListener("hashchange", cb), () => window.removeEventListener("hashchange", cb));
const useHash = () => useSyncExternalStore(onHash, () => window.location.hash.slice(1));

export function Health() {
  const { feed } = useApp();
  const param = useTabParam();
  const hash = useHash();
  const sitesOn = hasSites(feed);
  const tabs = HEALTH_TABS.filter((t) => t.id !== "sites" || sitesOn);
  const first = tabs[0]!.id;
  // An old section anchor (a bookmark to /health#deploys) names its tab too.
  const asked = healthTab(param) ?? healthTab(hash);
  const tab: HealthTab = asked && tabs.some((t) => t.id === asked) ? asked : first;
  return (
    <div className="page">
      <PageHead title="Health" />
      <Verdict />
      <Overview />
      <PageTabs label="Health" path="/health" tabs={tabs} current={tab} />
      <div className="embedded" id={tab} data-tab-panel={tab}>
        {panel(tab)}
      </div>
    </div>
  );
}

function panel(tab: HealthTab): ReactNode {
  switch (tab) {
    case "sites":
      return <Sites embedded />;
    case "problems":
      return (
        <>
          <Incidents embedded />
          <Suspense fallback={null}>
            <Maintenance />
          </Suspense>
        </>
      );
    case "deploys":
      return <Deploys embedded />;
    case "backups":
      return <Backups embedded />;
    case "ci":
      return <DefaultBranches />;
  }
}

// One line: "All good", or how many problems and the first few by name, each a link to
// where it is fixed. The same problems as Needs you's list (what waits on you is not one of
// them: it is in Waiting for you), so the two pages never disagree.
function Verdict() {
  const { feed, now, open } = useApp();
  const { problems } = attentionGroups(feed, now, WAITING_KINDS);
  if (!problems.length) {
    return (
      <p className="verdict" data-verdict="ok">
        <St kind="ok">All good</St>
        <span className="muted">Sites, backups and default branches were fine on the last pass.</span>
      </p>
    );
  }
  const kind = problems.some((p) => p.sev === "crit") ? "crit" : "warn";
  const named = problems.slice(0, NAMED);
  const rest = problems.length - named.length;
  return (
    <p className="verdict" data-verdict="problems">
      <St kind={kind}>
        {problems.length} {problems.length === 1 ? "problem" : "problems"}:
      </St>
      <span>
        {named.map((p, i) => (
          <span key={p.key}>
            <ProblemLink row={p} />
            {i < named.length - 1 ? " · " : ""}
          </span>
        ))}
        {rest > 0 && (
          <>
            {" and "}
            <button type="button" className="linkbtn" onClick={() => open("view:needs#attention")}>
              {rest} more
            </button>
          </>
        )}
      </span>
    </p>
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
