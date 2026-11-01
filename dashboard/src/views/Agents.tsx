import { ChartSlot } from "../ui/ChartSlot";
import { Suspense, lazy } from "react";
import { useApp } from "../app/ctx";
import { agentState, archiveAgents, nsList, rosterAgents } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

// Checks (the claims ledger; "Claims" until the UX audit's M5) is a tab of Agents
// (design-portal-evaluation.md section 2: both answer "how is this agent doing"), loaded when
// the tab opens. The tab is in the address (?tab=claims, its id unchanged), so it can be
// reloaded or shared.
const Claims = lazy(() => import("./Claims").then((m) => ({ default: m.Claims })));
// Chart 6, weekly model spend, sits under the roster.
const CostChart = lazy(() => import("./TrendCharts").then((m) => ({ default: m.CostChart })));

type Tab = "roster" | "archive" | "claims" | "access";

const TABS = [
  { id: "roster", label: "Agents" },
  { id: "archive", label: "Archive" },
  { id: "claims", label: "Checks" },
  { id: "access", label: "AI access" },
] as const;

export function Agents() {
  const asked = useTabParam();
  const tab: Tab = asked === "claims" || asked === "archive" || asked === "access" ? asked : "roster";
  return (
    <div className="page">
      <PageHead title="Agents" />
      <PageTabs label="Agents" path="/agents" tabs={TABS} current={tab} />
      {tab === "claims" ? (
        <Suspense fallback={null}>
          <Claims embedded />
        </Suspense>
      ) : tab === "archive" ? (
        <Archive />
      ) : tab === "access" ? (
        <Access />
      ) : (
        <Roster />
      )}
    </div>
  );
}

// Revoked agents leave the roster at once and the live table after 7 days (docs/auth.md);
// a one-job runner key leaves it sooner, once its job ends.
const ARCHIVE_AFTER_MS = 7 * 24 * 3_600_000;

// The revoked agents: still in the live table and waiting their 7 days, then the archived,
// newest move first. Both are history, so each row opens the agent's drawer as the roster's do.
function Archive() {
  const { feed, now } = useApp();
  const rows = archiveAgents(feed.live.agents);
  return (
    <div className="embedded">
      <Panel flush title="Archive" src="agents · agents_archive">
        {rows.length === 0 ? (
          <div className="body faint">No agent has been revoked.</div>
        ) : (
          <div className="scroll-x reflow">
            <table className="list cards-below-1100">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Revoked</th>
                  <th>Archive</th>
                  <th>Done / failed / blocked</th>
                  <th>PRs merged</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.name} className="click" data-row="" data-open={`agent:${a.name}`} tabIndex={0}>
                    <td>
                      <b>{a.name}</b>
                      <div className="src">
                        {a.kind} · {nsList(a)}
                      </div>
                    </td>
                    <td data-label="Revoked">{ago(ms(a.revoked_at as string), now)}</td>
                    <td data-label="Archive">
                      {a.archived_at ? (
                        <St kind="nodata">Archived {ago(ms(a.archived_at), now)}</St>
                      ) : (
                        <St kind="queued">Moves by {new Date(ms(a.revoked_at as string) + ARCHIVE_AFTER_MS).toLocaleDateString()}</St>
                      )}
                    </td>
                    <td data-label="Done / failed / blocked" className="num">
                      {a.jobs_done} / {a.jobs_failed} / {a.jobs_blocked}
                    </td>
                    <td data-label="PRs merged" className="num">
                      {a.prs_merged} of {a.prs_opened}
                    </td>
                    <td data-label="Last seen">{a.last_seen ? ago(ms(a.last_seen), now) : "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// Each MCP server's owner page (site-runtime ./owner-page, area 11 A15 and L9): the grants
// you gave AI clients there, each with Revoke, its agent keys and its tool-call log. The
// grants and the log live in each server's own Worker, and each server admits its own
// administrators, so each page is on its server, behind its own sign-in.
const OWNER_PAGES = [
  { name: "Capsid", url: "https://mcp.dustinedwards.info/owner" },
  { name: "Carrel", url: "https://carrel-mcp.dustinedwards.info/owner" },
  { name: "Dustin Edwards Admin", url: "https://admin-mcp.dustinedwards.info/owner" },
  { name: "Foxing Admin", url: "https://admin-mcp.foxing.app/owner" },
  { name: "Foxhound Admin", url: "https://admin-mcp.foxhoundapp.com/owner" },
] as const;

function Access() {
  return (
    <div className="embedded">
      <Panel flush title="AI access" src="each MCP server's owner page">
        <div className="body faint">Grants you gave AI clients, with Revoke, and every tool call. Each opens on its server after a sign-in.</div>
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Server</th>
                <th>Grants and tool calls</th>
              </tr>
            </thead>
            <tbody>
              {OWNER_PAGES.map((p) => (
                <tr key={p.name}>
                  <td>
                    <b>{p.name}</b>
                  </td>
                  <td>
                    <a href={p.url}>{p.url.replace("https://", "")}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Roster() {
  const { feed, now } = useApp();
  const live = feed.live;
  return (
    <div className="embedded">
      <Panel flush title="Roster" src="live agents · job outcomes">
        <div className="scroll-x reflow">
          <table className="list cards-below-1100">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Last seen</th>
                <th>Done / failed / blocked</th>
                <th>PRs merged</th>
                <th>Merge rate</th>
                <th>CI green</th>
                <th>Median job</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {rosterAgents(live.agents).map((a) => {
                const st = agentState(a, now);
                return (
                  <tr key={a.name} className="click" data-row="" data-open={`agent:${a.name}`} tabIndex={0}>
                    <td>
                      <b>{a.name}</b>
                      <div className="src">
                        {a.kind} · {nsList(a)}
                      </div>
                    </td>
                    <td data-label="Last seen">
                      <St kind={st.kind}>{st.label}</St>
                      <div className="src">{a.last_seen ? ago(ms(a.last_seen), now) : "never"}</div>
                    </td>
                    <td data-label="Done / failed / blocked" className="num">
                      {a.jobs_done} / {a.jobs_failed} / {a.jobs_blocked}
                    </td>
                    <td data-label="PRs merged" className="num">
                      {a.prs_merged} of {a.prs_opened}
                    </td>
                    <td data-label="Merge rate" className="num">{pct(a.pr_merge_rate, 0)}</td>
                    <td data-label="CI green" className="num">{pct(a.ci_green_rate, 0)}</td>
                    <td data-label="Median job" className="num">{a.median_duration_minutes == null ? "-" : `${a.median_duration_minutes} min`}</td>
                    <td data-label="Flags">
                      {a.flags.length ? (
                        a.flags.map((f) => (
                          <span key={f} className="chip flag">
                            {f}
                          </span>
                        ))
                      ) : (
                        <span className="faint">none</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <ChartSlot>
        <CostChart />
      </ChartSlot>
    </div>
  );
}
