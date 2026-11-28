import { Banner } from "capsomer/react/banner";
import { useUrlFilters } from "capsomer/react/route-hooks";
import { useApp } from "../app/ctx";
import { fetchActivity } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { actionWords } from "../lib/audit-words";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type { PortalActivity } from "../types";
import { Missing } from "capsomer/react/empty";
import { Spinner } from "capsomer/react/skeleton";
import { Panel } from "capsomer/react/panel";
import { Group } from "capsomer/react/disclosure";
import { Row, RowList } from "capsomer/react/row-list";
import "capsomer/group.css";
import "capsomer/row-list.css";
import { ReadAgain } from "capsomer/react/read-state";
import { ProjectSelect } from "./shared";
import { useFigures } from "../lib/trends";
import { boardChart, trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";

const MinutesTile = trendChart("MinutesTile");
const ServerFigure = boardChart("ServerFigure");

// Who acted, by day where the page is wide and by week on a phone (the Worker draws both).
function WhoActed() {
  const figs = useFigures("agents");
  const d = figs.data;
  if (!d) return null;
  if (!d.figures.who_acted)
    return <p className="cap-text">{d.empty.who_acted ?? "No one acted."}</p>;
  return (
    <ChartSlot>
      <ServerFigure html={d.figures.who_acted} narrow={d.figures.who_acted_weeks} />
    </ChartSlot>
  );
}

export function Activity() {
  const { feed, now: appNow } = useApp();
  const filters = useUrlFilters(["namespace", "actor"] as const, { fixed: { tab: "activity" } });
  const { namespace, actor } = filters.applied;
  const { namespace: nsInput, actor: actorInput } = filters.input;

  const load = useAnswer<PortalActivity>(["activity", namespace, actor], () =>
    fetchActivity({ namespace, actor }),
  );

  const data = load.data;
  const now = data ? Math.max(appNow, parse(data.generated)) : appNow;
  const actors = [
    ...new Set([
      ...feed.live.agents.map((a) => `agent:${a.name}`),
      ...(data?.rows ?? []).map((r) => r.actor).filter((a): a is string => !!a),
      ...(actor ? [actor] : []),
    ]),
  ].sort();

  return (
    <div className="cap-stack">
      <WeeklyDigest />
      <WhoActed />
      <form
        className="cap-cluster"
        data-gap="3"
        role="search"
        aria-label="Filter activity"
        onSubmit={(e) => {
          e.preventDefault();
          filters.apply();
        }}
      >
        <ProjectSelect
          id="actNs"
          value={nsInput}
          applied={namespace}
          onChange={(namespace) => filters.setInput({ namespace })}
        />
        <label className="cap-sr-only" htmlFor="actActor">
          Who
        </label>
        <select
          id="actActor"
          name="actor"
          className="search"
          value={actorInput}
          onChange={(e) => filters.setInput({ actor: e.target.value })}
        >
          <option value="">Anyone</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button type="submit" className="cap-btn">
          Apply
        </button>
        {(namespace || actor) && (
          <button
            type="button"
            className="cap-btn"
            onClick={() => filters.apply({ namespace: "", actor: "" })}
          >
            Clear
          </button>
        )}
      </form>
      {load.error && (
        <Banner tone="crit">
          Could not read the activity: {load.error}
          {data ? `. Showing the read from ${ago(parse(data.generated), now)}.` : ""}
        </Banner>
      )}
      <Panel
        flush
        title="Audit log"
        count={data?.rows.length}
        src={
          <>
            {data ? `at most ${data.limit} rows · ` : ""}
            <ReadAgain
              at={data ? parse(data.generated) : undefined}
              now={now}
              reading={load.loading}
              onRead={load.reread}
            />
          </>
        }
      >
        {!data && load.loading ? (
          <Spinner layout="page" label="Reading the activity..." />
        ) : data && data.rows.length ? (
          <div className="cap-table-wrap">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Project</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.id}
                    className="click"
                    data-row=""
                    data-open={`audit:${r.id}`}
                    tabIndex={0}
                  >
                    <td className="cap-num" title={utc(parse(r.at))}>
                      {ago(parse(r.at), now)}
                    </td>
                    <td className="cap-mono">
                      {r.actor ?? <Missing />}
                      {r.client && <div className="src">via {r.client}</div>}
                    </td>
                    <td>
                      {actionWords(r.action) ?? (
                        <span className="cap-mono">{r.action ?? <Missing />}</span>
                      )}
                      {actionWords(r.action) && <div className="src cap-mono">{r.action}</div>}
                    </td>
                    <td className="cap-mono">{r.namespace ?? <Missing />}</td>
                    <td className="cap-mono wrap">{r.path ?? <Missing />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="cap-text body" data-tone="dim">
            {data.filter.namespace || data.filter.actor
              ? "No rows match these filters."
              : "The audit log has no rows."}
          </div>
        ) : null}
      </Panel>
      <div className="chart-row" id="trends">
        <ChartSlot>
          <MinutesTile />
        </ChartSlot>
      </div>
    </div>
  );
}

function WeeklyDigest() {
  const { feed, now } = useApp();
  const open = feed.live.findings.filter((f) => f.class === "digest");
  if (open.length === 0) return null;
  const sites = [...new Set(open.map((f) => f.namespace))].sort();
  return (
    <Panel title="Weekly digest" id="weekly-digest" section="Weekly digest" count={open.length}>
      {sites.map((site) => {
        const mine = open.filter((f) => f.namespace === site);
        return (
          <div key={site} data-digest-site={site}>
            <Group
              label={`${site}, open`}
              count={mine.length}
              defaultExpanded
              headingLevel={3}
              body="list"
            >
              <RowList label={`Weekly digest, ${site}`}>
                {mine.map((f) => (
                  <Row
                    key={f.fingerprint}
                    title={f.headline}
                    detail={f.evidence.join(" · ") || undefined}
                    meta={`since ${ago(parse(f.first_seen), now)}`}
                  />
                ))}
              </RowList>
            </Group>
          </div>
        );
      })}
    </Panel>
  );
}
