import { Banner } from "capsomer/react/banner";
import { useUrlFilters } from "capsomer/react/route-hooks";
import { useApp } from "../app/ctx";
import { fetchActivity } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { actionWords } from "../lib/audit-words";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type { PortalActivity } from "../types";
import { Missing, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { PageHead, ProjectSelect } from "./shared";

// The filters live in the address (?namespace=&actor=), so a filtered view can be
// reloaded or shared. The inputs apply on submit, not on each keystroke.
// A job transition writes two rows with the same action, actor and path; this says which
// is the job's and which its mirror document's.
const TARGET_LABEL: Record<"job" | "document", string> = {
  job: "(job)",
  document: "(mirror document)",
};

export function Activity() {
  const { feed, now: appNow } = useApp();
  // The filter lives in the address (capsomer/react/route-hooks): the fields follow it (back, a link)
  // and apply on submit, replacing the history entry.
  const filters = useUrlFilters(["namespace", "actor"] as const);
  const { namespace, actor } = filters.applied;
  const { namespace: nsInput, actor: actorInput } = filters.input;

  const load = useAnswer<PortalActivity>(["activity", namespace, actor], () =>
    fetchActivity({ namespace, actor }),
  );

  const data = load.data;
  // The rows were just read from the server, so none is later than the read itself.
  const now = data ? Math.max(appNow, parse(data.generated)) : appNow;
  const actors = [
    ...new Set([
      ...feed.live.agents.map((a) => `agent:${a.name}`),
      ...(data?.rows ?? []).map((r) => r.actor).filter((a): a is string => !!a),
      ...(actor ? [actor] : []),
    ]),
  ].sort();

  return (
    <div className="cap-admin-page">
      <PageHead title="Activity" />
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
        {/* A picker, not a box to type an id into from memory (the UX audit's m7): every
            agent on the roster, and every actor in the rows read. */}
        <select
          id="actActor"
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
            {data ? `newest first, at most ${data.limit} rows · ` : ""}
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
          <div className="loading" role="status">
            <Spinner label="Reading the activity..." />
          </div>
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
                      {r.target && (
                        <span className="cap-text" data-tone="dim">
                          {" "}
                          {TARGET_LABEL[r.target]}
                        </span>
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
        ) : (
          <div className="cap-text body" data-tone="dim">
            No read yet.
          </div>
        )}
      </Panel>
    </div>
  );
}
