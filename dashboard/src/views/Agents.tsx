import { AGENT_TABS, tabOf, useApp } from "../app/ctx";
import { archiveAgents, nsList } from "../lib/agents";
import { useFigures } from "../lib/trends";
import { ChartSlot } from "../ui/ChartSlot";
import { Activity } from "./Activity";
import { boardChart } from "./charts";
import { DAY, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";
import type { OpsAgent } from "../types";

const RosterTable = boardChart("RosterTable");

export function Agents() {
  const tab = tabOf(AGENT_TABS, useTabParam()) ?? AGENT_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Agents" />
      <PageTabs label="Agents" path="/agents" tabs={AGENT_TABS} current={tab} />
      {tab === "archive" ? (
        <Archive />
      ) : tab === "access" ? (
        <Access />
      ) : tab === "activity" ? (
        <Activity />
      ) : (
        <Roster />
      )}
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

// Revoked agents wait 7 days in the live table (docs/auth.md), then are archived. Both are history, so rows open the drawer.
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
  const figs = useFigures("roster");
  return (
    <div className="cap-stack">
      <Panel flush title="Live agents">
        <div className="body">
          <ChartSlot>
            <RosterTable actors={figs.data?.actors ?? null} />
          </ChartSlot>
        </div>
      </Panel>
    </div>
  );
}
