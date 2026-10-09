import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Spinner } from "capsomer/react/empty";
import { routePath, useApp } from "../app/ctx";
import { fetchStale } from "../lib/api";
import { JOB } from "../lib/derive";
import { agentLabel, ago, ms } from "../lib/format";
import type { OpsJob, PortalStale, StaleRule } from "../types";
import { St } from "../ui/icons";
import { Anchors } from "../ui/anchors";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { FilterEmpty, NsChips, PageHead, QueueRows, useNsFilter } from "./shared";

// The state only: the switch is in the Automation panel on Namespaces (DECIDE 7).
export function SeatStart() {
  const { feed, now } = useApp();
  const s = feed.live.seat_start;
  return (
    <dl className="kv">
      <dt>Seat start</dt>
      <dd className="toolbar">
        {s.enabled ? <St kind="ok">On</St> : <St kind="nodata">Off</St>}
        <Link href={routePath("namespaces")}>Change it in Namespaces</Link>
      </dd>
      <dt>In flight</dt>
      <dd className="num">
        {s.in_flight} of {s.max_sessions}
      </dd>
      <dt>Last 7 days</dt>
      <dd>
        {s.recent.length
          ? s.recent.map((r) => (
              <div key={`${r.job_id}-${r.at}`}>
                <span className="mono">{r.job_id}</span>{" "}
                <span className="faint">
                  {r.namespace ?? "no namespace"} · {ago(ms(r.at), now)} ·{" "}
                </span>
                {r.run_url ? (
                  <a href={r.run_url} target="_blank" rel="noopener noreferrer">
                    run {r.run_id ?? ""}
                  </a>
                ) : (
                  <span className="faint">runner never presented its token</span>
                )}
              </div>
            ))
          : <span className="faint">No sessions started.</span>}
      </dd>
    </dl>
  );
}

// Claude Code sessions reporting through their hooks (POST /ops/hooks, docs/hooks.md):
// the job each is bound to, the key, its last event, whether it waits on a person, and
// its last failure.
export function LiveSessions() {
  const { feed, now } = useApp();
  const list = feed.live.sessions;
  if (!list.length) return <Empty kind="all-clear" title="No live sessions in the last 24 hours." />;
  // A row names the session's job by its title; the id is in the job's drawer (D11).
  const title = (id: string | null) => (id ? (feed.live.jobs.find((j) => j.id === id)?.title ?? "A job outside the live window") : "No job bound");
  return (
    <>
      {list.map((s) => (
        <div className={s.last_failure && s.incident === "failure" ? "qrow sev-crit" : "qrow"} key={s.session_id} data-row="" data-session={s.session_id} data-open={s.job_id ? `job:${s.job_id}` : undefined} tabIndex={s.job_id ? 0 : undefined}>
          {s.last_failure ? (
            <St kind={s.incident === "failure" ? "crit" : "warn"}>Failed</St>
          ) : s.needs_input ? (
            <St kind={s.incident === "waiting" ? "warn" : "blocked"}>Needs input</St>
          ) : (
            <St kind="run">Running</St>
          )}
          <div className="t">
            <b>{title(s.job_id)}</b>
            <div>
              {agentLabel(s.agent)}
              {s.namespace ? ` · ${s.namespace}` : ""}
              {s.last_failure ? ` · failure: ${s.last_failure}` : ""}
            </div>
          </div>
          <div className="m">
            {s.last_event === "Notification" && s.last_notification_type ? s.last_notification_type : s.last_event}
            <br />
            {ago(ms(s.last_event_at), now)}
          </div>
        </div>
      ))}
    </>
  );
}

// What each stale rule is called in a row, the most actionable first, as the Worker
// orders them (src/stale-jobs.ts).
const STALE_RULE: Record<StaleRule, string> = {
  "prs-settled": "Pull requests settled",
  "resumed-not-completed": "Resumed, not finished",
  unchanged: "Unchanged 3 days",
};

type StaleLoad = { data: PortalStale | null; loading: boolean; error: string | null };

// The stale view (capsid/research/design-stale-jobs.md): GET /portal/api/stale, the same
// rows `jobs` list with stale: true returns. Read when the Queue opens and again with
// each feed, so a resume or a close performed from the drawer drops its row.
function useStale(): { load: StaleLoad; reread: () => void } {
  const { feed, signOut } = useApp();
  const [load, setLoad] = useState<StaleLoad>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const generated = feed.live.generated;
  useEffect(() => {
    let alive = true;
    setLoad((l) => ({ ...l, loading: true }));
    void fetchStale().then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setLoad({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      const message = r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message;
      setLoad((l) => ({ ...l, loading: false, error: message }));
    });
    return () => {
      alive = false;
    };
  }, [generated, tick, signOut]);
  return { load, reread: () => setTick((t) => t + 1) };
}

// The panel. A row opens the job's drawer, which holds the controls (Resume, Close as
// shipped and the rest); nothing here changes a job.
export function StaleJobs({ load, reread }: { load: StaleLoad; reread: () => void }) {
  const { now } = useApp();
  // The Queue's namespace chips narrow these rows too.
  const [ns] = useNsFilter();
  const data = load.data;
  const rows = data ? data.rows.filter((j) => ns === "all" || j.namespace === ns) : [];
  return (
    <Panel
      flush
      title="Stale jobs"
      id="stale-jobs"
      section="Stale jobs"
      count={data ? rows.length : undefined}
      src={
        <>
          {data ? `read ${ago(ms(data.generated), now)} · ` : ""}
          <button type="button" className="btn" disabled={load.loading} onClick={reread}>
            {load.loading ? "Reading..." : "Read again"}
          </button>
        </>
      }
    >
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the stale jobs: {load.error}
          {data ? `. Showing the read from ${ago(ms(data.generated), now)}.` : ""}
        </div>
      )}
      {data?.note && <div className="callout warn">{data.note}</div>}
      {!data && load.loading ? (
        <div className="loading" role="status">
          <Spinner label="Reading the stale jobs..." />
        </div>
      ) : rows.length ? (
        rows.map((j) => {
          const k = JOB[j.status as OpsJob["status"]] ?? { kind: "nodata" as const, label: j.status };
          return (
            <div className="qrow" key={j.id} data-row="" data-open={`job:${j.id}`} data-rule={j.rule} tabIndex={0}>
              <St kind={k.kind}>{k.label}</St>
              <div className="t">
                <b>{j.title}</b>
                <div className="why">{j.reason}</div>
              </div>
              <div className="m">
                <span className="ns">{j.namespace}</span>
                <br />
                {STALE_RULE[j.rule]}
              </div>
            </div>
          );
        })
      ) : data ? (
        <Empty kind="all-clear" title={ns === "all" ? "No job looks stuck." : `No job in ${ns} looks stuck.`} />
      ) : (
        <div className="body faint">No read yet.</div>
      )}
    </Panel>
  );
}

export function Queue() {
  const { feed, filters, setFilters } = useApp();
  const [ns, setNs] = useNsFilter();
  const all = feed.live.jobs;
  const q = filters.q.trim().toLowerCase();
  const jobs = all.filter((j) => (ns === "all" || j.namespace === ns) && (!q || `${j.title} ${j.id} ${j.waits_on ?? ""} ${j.command ?? ""}`.toLowerCase().includes(q)));
  const nss = [...new Set(all.map((j) => j.namespace))];
  // Stale jobs show in one place: the panel (Dustin, 2026-10-09, folding the list's old
  // "Stale, blocked over 7 days" group into it). The list leaves out every job the panel
  // holds; until the panel has read, or when its read fails, the list shows every job.
  const stale = useStale();
  const inPanel = new Set(stale.load.data?.rows.map((r) => r.id) ?? []);
  return (
    <div className="page">
      <Anchors />
      <PageHead title="Queue" />
      <div className="toolbar">
        <NsChips list={nss} />
        <input className="search" id="qsearch" type="search" placeholder="Filter jobs (f)" value={filters.q} aria-label="Filter jobs" onChange={(e) => setFilters({ q: e.target.value })} />
      </div>
      <StaleJobs load={stale.load} reread={stale.reread} />
      <div className="grid2">
        <Panel flush title="Jobs" id="jobs" section="Jobs" src="live · D1 jobs, read on each refresh">
          {!jobs.length && all.length ? (
            <FilterEmpty onShowAll={() => (setFilters({ q: "" }), setNs("all"))}>
              No job {q ? `matches the text "${filters.q.trim()}"` : "is listed"}
              {ns !== "all" ? ` in the namespace ${ns}` : ""}.
            </FilterEmpty>
          ) : (
            <QueueRows jobs={jobs.filter((j) => !inPanel.has(j.id))} />
          )}
        </Panel>
        <Panel flush title="By namespace" id="by-namespace" section="By namespace">
          <div className="scroll-x">
            <table className="list">
              <tbody>
                {nss.map((ns) => {
                  const js = all.filter((j) => j.namespace === ns);
                  const b = js.filter((j) => j.status === "blocked").length;
                  const r = js.filter((j) => j.status === "claimed").length;
                  const qd = js.filter((j) => j.status === "queued").length;
                  const tot = Math.max(1, b + r + qd);
                  return (
                    <tr key={ns}>
                      <td className="mono">{ns}</td>
                      <td className="w50">
                        <div className="stack" role="img" aria-label={`${ns}: ${b} blocked, ${r} running, ${qd} queued`}>
                          <i className="b" style={{ width: `${(b / tot) * 100}%` }} />
                          <i className="r" style={{ width: `${(r / tot) * 100}%` }} />
                          <i className="q" style={{ width: `${(qd / tot) * 100}%` }} />
                        </div>
                      </td>
                      <td className="num">{b} blocked</td>
                      <td className="num">{r} running</td>
                      <td className="num">{qd} queued</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="body">
            <p className="section-title">Seat-started sessions</p>
            <SeatStart />
          </div>
        </Panel>
        <Panel flush title="Live sessions" id="live-sessions" section="Live sessions" src="live · hook events, D1 agent_sessions" count={feed.live.sessions.length}>
          <LiveSessions />
        </Panel>
      </div>
    </div>
  );
}
