import { AGENT_TABS, tabOf, useApp } from "../app/ctx";
import { KIND_STATUS } from "../lib/derive";
import { agentState, archiveAgents, nsList, rosterAgents } from "../lib/agents";
import { DAY, ago, pct } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";
import { Missing } from "capsomer/react/empty";
import type { OpsAgent } from "../types";

export function Agents() {
  const tab = tabOf(AGENT_TABS, useTabParam()) ?? AGENT_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Agents" />
      <PageTabs label="Agents" path="/agents" tabs={AGENT_TABS} current={tab} />
      {tab === "archive" ? <Archive /> : tab === "access" ? <Access /> : <Roster />}
    </div>
  );
}

function AgentName({ a }: { a: OpsAgent }) {
  return (
    <td>
      <b>{a.name}</b>
      <div className="src">
        {a.kind} · {nsList(a)}
      </div>
    </td>
  );
}

function AgentWork({ a }: { a: OpsAgent }) {
  return (
    <>
      <td data-label="Done / failed / blocked" className="cap-num">
        {a.jobs_done} / {a.jobs_failed} / {a.jobs_blocked}
      </td>
      <td data-label="PRs merged" className="cap-num">
        {a.prs_merged} of {a.prs_opened}
      </td>
    </>
  );
}

// Revoked agents wait 7 days in the live table (docs/auth.md; a one-job runner key leaves sooner), then are archived. Both are history, so rows open the drawer.
function Archive() {
  const { feed, now } = useApp();
  const rows = archiveAgents(feed.live.agents);
  return (
    <div className="cap-stack">
      <Panel flush title="Archive">
        {rows.length === 0 ? (
          <div className="cap-text body" data-tone="dim">
            No agent has been revoked.
          </div>
        ) : (
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table">
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
                  <tr
                    key={a.name}
                    className="click"
                    data-row=""
                    data-open={`agent:${a.name}`}
                    tabIndex={0}
                  >
                    <AgentName a={a} />
                    <td data-label="Revoked">{ago(parse(a.revoked_at as string), now)}</td>
                    <td data-label="Archive">
                      {a.archived_at ? (
                        <Status tone="nodata">Archived {ago(parse(a.archived_at), now)}</Status>
                      ) : (
                        <Status tone="muted" glyph="queued">
                          Moves by{" "}
                          {new Date(parse(a.revoked_at as string) + 7 * DAY)
                            .toISOString()
                            .slice(0, 10)}
                        </Status>
                      )}
                    </td>
                    <AgentWork a={a} />
                    <td data-label="Last seen">
                      {a.last_seen ? ago(parse(a.last_seen), now) : "never"}
                    </td>
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

// Each MCP server's owner page (site-runtime ./owner-page, area 11 A15 and L9): grants, agent keys and tool-call log live in that
// server's own Worker behind its own sign-in, so each page is on its server.
const OWNER_PAGES = [
  { name: "Capsid", url: "https://mcp.dustinedwards.info/owner" },
  { name: "Carrel", url: "https://carrel-mcp.dustinedwards.info/owner" },
  {
    name: "Dustin Edwards Admin",
    url: "https://admin-mcp.dustinedwards.info/owner",
  },
  { name: "Foxing Admin", url: "https://admin-mcp.foxing.app/owner" },
  { name: "Foxhound Admin", url: "https://admin-mcp.foxhoundapp.com/owner" },
] as const;

function Access() {
  return (
    <div className="cap-stack">
      <Panel flush title="AI access">
        <div className="cap-table-wrap">
          <table className="cap-table">
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
    <div className="cap-stack">
      <Panel flush title="Roster">
        <div className="cap-table-wrap" data-reflow="wide">
          <table className="cap-table">
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
                  <tr
                    key={a.name}
                    className="click"
                    data-row=""
                    data-open={`agent:${a.name}`}
                    tabIndex={0}
                  >
                    <AgentName a={a} />
                    <td data-label="Last seen">
                      <Status {...KIND_STATUS[st.kind]}>{st.label}</Status>
                      <div className="src">
                        {a.last_seen ? ago(parse(a.last_seen), now) : "never"}
                      </div>
                    </td>
                    <AgentWork a={a} />
                    <td data-label="Merge rate" className="cap-num">
                      {pct(a.pr_merge_rate, 0)}
                    </td>
                    <td data-label="CI green" className="cap-num">
                      {pct(a.ci_green_rate, 0)}
                    </td>
                    <td data-label="Median job" className="cap-num">
                      {a.median_duration_minutes == null ? "-" : `${a.median_duration_minutes} min`}
                    </td>
                    <td data-label="Flags">
                      {a.flags.length ? (
                        a.flags.map((f) => (
                          <span key={f} className="cap-pill" data-variant="outline">
                            {f}
                          </span>
                        ))
                      ) : (
                        <Missing />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
