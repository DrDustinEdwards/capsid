import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useApp } from "../app/ctx";
import { fetchActivity } from "../lib/api";
import { ago, ms, utc } from "../lib/format";
import type { PortalActivity } from "../types";
import { PageHead, Panel } from "./shared";

interface Load {
  data: PortalActivity | null;
  loading: boolean;
  error: string | null;
}

function None() {
  return <span className="faint">none</span>;
}

// The filters live in the address (?namespace=&actor=), so a filtered view can be
// reloaded or shared. The inputs apply on submit, not on each keystroke.
export function Activity() {
  const { feed, now, signOut } = useApp();
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const namespace = params.get("namespace") ?? "";
  const actor = params.get("actor") ?? "";
  const [nsInput, setNsInput] = useState(namespace);
  const [actorInput, setActorInput] = useState(actor);
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setNsInput(namespace);
    setActorInput(actor);
  }, [namespace, actor]);

  useEffect(() => {
    let alive = true;
    setLoad((l) => ({ ...l, loading: true }));
    void fetchActivity({ namespace, actor }).then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setLoad({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      const message = r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message;
      setLoad((l) => ({ ...l, loading: false, error: message }));
    });
    return () => {
      alive = false;
    };
  }, [namespace, actor, tick, signOut]);

  const apply = (ns: string, who: string) => {
    const qs = new URLSearchParams();
    if (ns.trim()) qs.set("namespace", ns.trim());
    if (who.trim()) qs.set("actor", who.trim());
    const s = qs.toString();
    navigate(s ? `/activity?${s}` : "/activity", { replace: true });
  };

  const data = load.data;
  const names = feed.live.namespaces.map((n) => n.name);
  if (namespace && !names.includes(namespace)) names.push(namespace);

  return (
    <div className="page">
      <PageHead title="Activity">The audit log, newest first: who did what, where. Filter by namespace or actor.</PageHead>
      <form
        className="toolbar"
        role="search"
        aria-label="Filter activity"
        onSubmit={(e) => {
          e.preventDefault();
          apply(nsInput, actorInput);
        }}
      >
        <label className="sr-only" htmlFor="actNs">
          Namespace
        </label>
        <select id="actNs" className="search" value={nsInput} onChange={(e) => setNsInput(e.target.value)}>
          <option value="">All namespaces</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="actActor">
          Actor
        </label>
        <input id="actActor" className="search" type="search" placeholder="Actor, e.g. agent:watcher" value={actorInput} onChange={(e) => setActorInput(e.target.value)} />
        <button type="submit" className="btn">
          Apply
        </button>
        {(namespace || actor) && (
          <button type="button" className="btn" onClick={() => apply("", "")}>
            Clear
          </button>
        )}
      </form>
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the activity: {load.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      <Panel
        title="Audit log"
        count={data?.rows.length}
        src={
          <>
            {data ? `newest first, at most ${data.limit} rows · read ${ago(ms(data.generated), now)} · ` : ""}
            <button type="button" className="linkbtn" disabled={load.loading} onClick={() => setTick((t) => t + 1)}>
              {load.loading ? "Reading..." : "Read again"}
            </button>
          </>
        }
      >
        {!data && load.loading ? (
          <div className="loading" role="status">
            Reading the activity...
          </div>
        ) : data && data.rows.length ? (
          <div className="scroll-x">
            <table className="list">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Namespace</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={`${r.at}-${i}`} data-row="">
                    <td className="mono" title={utc(ms(r.at))}>
                      {ago(ms(r.at), now)}
                    </td>
                    <td className="mono">{r.actor ?? <None />}</td>
                    <td className="mono">{r.action ?? <None />}</td>
                    <td className="mono">{r.namespace ?? <None />}</td>
                    <td className="mono wrap">{r.path ?? <None />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : data ? (
          <div className="body faint">{data.filter.namespace || data.filter.actor ? "No rows match these filters." : "The audit log has no rows."}</div>
        ) : (
          <div className="body faint">No read yet.</div>
        )}
      </Panel>
    </div>
  );
}
