import { useApp } from "../app/ctx";
import { agentState, nsList, type Kind } from "../lib/derive";
import { ago, ms, pct } from "../lib/format";
import { St } from "../ui/icons";
import { PageHead, Panel } from "./shared";

function modeKind(mode: string): Kind {
  return mode === "on" ? "ok" : mode === "paused" ? "warn" : "nodata";
}

export function Agents() {
  const { feed, now } = useApp();
  const live = feed.live;
  const b = live.loop.budget;
  const minFrac = b.caps.actions_minutes_month ? b.spend.ci_minutes / b.caps.actions_minutes_month : 0;
  const usdFrac = b.caps.model_usd_month ? b.spend.cost_usd / b.caps.model_usd_month : 0;
  return (
    <div className="page">
      <PageHead title="Agents">Every credential, what it did, and when it was last seen. Counts and rates only; the verified columns are what the Worker checked against GitHub.</PageHead>
      <Panel title="Roster" src="agents · job outcomes">
        <div className="scroll-x">
          <table className="list minw860">
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
              {live.agents.map((a) => {
                const st = agentState(a, now);
                return (
                  <tr key={a.name} className="click" data-row="" data-open={`agent:${a.name}`} tabIndex={0}>
                    <td>
                      <b>{a.name}</b>
                      <div className="src">
                        {a.kind} · {nsList(a)}
                      </div>
                    </td>
                    <td>
                      <St kind={st.kind}>{st.label}</St>
                      <div className="src">{a.revoked_at ? `revoked ${ago(ms(a.revoked_at), now)}` : a.last_seen ? ago(ms(a.last_seen), now) : "never"}</div>
                    </td>
                    <td className="mono">
                      {a.jobs_done} / {a.jobs_failed} / {a.jobs_blocked}
                    </td>
                    <td className="mono">
                      {a.prs_merged} of {a.prs_opened}
                    </td>
                    <td className="mono">{pct(a.pr_merge_rate, 0)}</td>
                    <td className="mono">{pct(a.ci_green_rate, 0)}</td>
                    <td className="mono">{a.median_duration_minutes == null ? "-" : `${a.median_duration_minutes} min`}</td>
                    <td>
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
      <Panel title="Improve loop and budget" src={`month ${b.month}`}>
        <div className="body">
          <dl className="kv">
            <dt>Mode</dt>
            <dd>
              <St kind={modeKind(live.loop.mode)}>{live.loop.mode}</St>
            </dd>
            <dt>Actions minutes</dt>
            <dd>
              <div className="meter" role="img" aria-label={`${b.spend.ci_minutes} of ${b.caps.actions_minutes_month} Actions minutes`}>
                <i className={minFrac > 1 ? "crit" : minFrac > 0.8 ? "warn" : ""} style={{ width: `${Math.min(100, minFrac * 100)}%` }} />
              </div>
              <span className="mono">
                {b.spend.ci_minutes} of {b.caps.actions_minutes_month} this month
              </span>
            </dd>
            <dt>Model spend</dt>
            <dd>
              <div className="meter" role="img" aria-label={`$${b.spend.cost_usd.toFixed(2)} of $${b.caps.model_usd_month}`}>
                <i className={usdFrac > 1 ? "crit" : usdFrac > 0.8 ? "warn" : ""} style={{ width: `${Math.min(100, usdFrac * 100)}%` }} />
              </div>
              <span className="mono">
                ${b.spend.cost_usd.toFixed(2)} of ${b.caps.model_usd_month} (estimate)
              </span>
            </dd>
            <dt>Budget</dt>
            <dd>{b.exceeded ? <St kind="crit">Exceeded</St> : <St kind="ok">Within caps</St>}</dd>
          </dl>
        </div>
      </Panel>
    </div>
  );
}
