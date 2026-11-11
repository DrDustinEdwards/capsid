import { type FormEvent } from "react";
import "capsomer/button.css";
import "capsomer/filter-bar.css";
import { FilterBar, hasFilters, withParams } from "capsomer/react/filter-bar";
import { Spinner } from "capsomer/react/empty";
import { Link, useLocation, useSearch } from "../lib/router";
import { useApp } from "../app/ctx";
import { fetchActivity, useAnswer } from "../lib/api";
import { actionWords } from "../lib/audit-words";
import { ago, ms, utc } from "../lib/format";
import type { PortalActivity } from "../types";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

function None() {
  return <span className="faint">none</span>;
}

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
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const namespace = params.get("namespace") ?? "";
  const actor = params.get("actor") ?? "";

  const load = useAnswer<PortalActivity>(["activity", namespace, actor], () =>
    fetchActivity({ namespace, actor }),
  );

  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    navigate(
      withParams("/activity", {
        namespace: form.get("namespace") as string,
        actor: form.get("actor") as string,
      }),
      { replace: true },
    );
  };

  const data = load.data;
  // The rows were just read from the server, so none is later than the read itself.
  const now = data ? Math.max(appNow, ms(data.generated)) : appNow;
  const names = feed.live.namespaces.map((n) => n.name);
  if (namespace && !names.includes(namespace)) names.push(namespace);
  const actors = [
    ...new Set([
      ...feed.live.agents.map((a) => `agent:${a.name}`),
      ...(data?.rows ?? []).map((r) => r.actor).filter((a): a is string => !!a),
      ...(actor ? [actor] : []),
    ]),
  ].sort();

  return (
    <div className="page">
      <PageHead title="Activity" />
      {/* The address changed (back, a link): the fields follow it, so the bar starts over. */}
      <FilterBar
        key={`${namespace}\u0000${actor}`}
        label="Filter activity"
        onSubmit={apply}
        clearLabel="Clear"
        clearHref={hasFilters({ namespace, actor }, ["namespace", "actor"]) ? "/activity" : null}
        renderLink={(props) => <Link {...props} />}
      >
        <label className="sr-only" htmlFor="actNs">
          Project
        </label>
        <select id="actNs" className="search" name="namespace" defaultValue={namespace}>
          <option value="">All projects</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="actActor">
          Who
        </label>
        {/* A picker, not a box to type an id into from memory (the UX audit's m7): every
            agent on the roster, and every actor in the rows read. */}
        <select id="actActor" className="search" name="actor" defaultValue={actor}>
          <option value="">Anyone</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </FilterBar>
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the activity: {load.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      <Panel
        flush
        title="Audit log"
        count={data?.rows.length}
        src={
          <>
            {data
              ? `newest first, at most ${data.limit} rows · read ${ago(ms(data.generated), now)} · `
              : ""}
            <button type="button" className="btn" disabled={load.loading} onClick={load.reread}>
              {load.loading ? "Reading..." : "Read again"}
            </button>
          </>
        }
      >
        {!data && load.loading ? (
          <div className="loading" role="status">
            <Spinner label="Reading the activity..." />
          </div>
        ) : data && data.rows.length ? (
          <div className="scroll-x">
            <table className="list">
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
                    <td className="num" title={utc(ms(r.at))}>
                      {ago(ms(r.at), now)}
                    </td>
                    <td className="mono">
                      {r.actor ?? <None />}
                      {r.client && <div className="src">via {r.client}</div>}
                    </td>
                    <td>
                      {actionWords(r.action) ?? (
                        <span className="mono">{r.action ?? <None />}</span>
                      )}
                      {r.target && <span className="faint"> {TARGET_LABEL[r.target]}</span>}
                      {actionWords(r.action) && <div className="src mono">{r.action}</div>}
                    </td>
                    <td className="mono">{r.namespace ?? <None />}</td>
                    <td className="mono wrap">{r.path ?? <None />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="body faint">
            {data.filter.namespace || data.filter.actor
              ? "No rows match these filters."
              : "The audit log has no rows."}
          </div>
        ) : (
          <div className="body faint">No read yet.</div>
        )}
      </Panel>
    </div>
  );
}
