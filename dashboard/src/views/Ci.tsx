import { useApp } from "../app/ctx";
import { ciState } from "../lib/derive";
import { ago, ms, utc } from "../lib/format";
import { St } from "../ui/icons";
import { NoSnapshot, PageHead, Panel } from "./shared";

function prLabel(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]} #${m[2]}` : url;
}

export function Ci() {
  const { feed, now } = useApp();
  const snap = feed.snapshot;
  const live = feed.live;
  return (
    <div className="page">
      <PageHead title="CI and merges">The default branch of every roster repo, and the pull requests agents opened or the seat merged.</PageHead>
      <Panel title="Default branches" src="watcher ci check · GitHub App">
        {snap ? (
          <div className="scroll-x">
            <table className="list minw700">
              <thead>
                <tr>
                  <th>Namespace</th>
                  <th>Latest run</th>
                  <th>Sha</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snap.ci.map((c) => {
                  const st = ciState(c);
                  return (
                    <tr key={c.namespace}>
                      <td>
                        <b>{c.namespace}</b>
                      </td>
                      <td>
                        <St kind={st.kind}>{st.label}</St>
                      </td>
                      <td className="mono">{c.latest ? c.latest.head_sha.slice(0, 7) : "-"}</td>
                      <td className="mono" title={c.latest ? utc(ms(c.latest.created_at)) : undefined}>
                        {c.latest ? ago(ms(c.latest.created_at), now) : <span className="faint">runs could not be read</span>}
                      </td>
                      <td>
                        {c.latest?.url && (
                          <a href={c.latest.url} target="_blank" rel="noopener noreferrer">
                            run
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="body">
            <NoSnapshot />
          </div>
        )}
      </Panel>
      <Panel title="Pull requests, last 7 days" src="recorded against jobs" count={live.prs.length}>
        <div className="scroll-x">
          <table className="list minw760">
            <thead>
              <tr>
                <th>PR</th>
                <th>Job</th>
                <th>State</th>
                <th>Verified</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {live.prs.map((p) => {
                const job = live.jobs.find((j) => j.id === p.job_id);
                return (
                  <tr key={`${p.job_id}-${p.pr_url}`} className={job ? "click" : undefined} data-row="" data-open={job ? `job:${job.id}` : undefined} tabIndex={job ? 0 : undefined}>
                    <td className="mono">
                      <a href={p.pr_url} target="_blank" rel="noopener noreferrer">
                        {prLabel(p.pr_url)}
                      </a>
                    </td>
                    <td>{job ? job.title : <span className="mono faint">{p.job_id}</span>}</td>
                    <td>{p.merged === true ? <St kind="ok">Merged</St> : p.merged === false ? <St kind="crit">Not merged</St> : <St kind="run">Open</St>}</td>
                    <td className="mono">{p.merge_verified_at ? ago(ms(p.merge_verified_at), now) : <span className="faint">not yet</span>}</td>
                    <td className="mono">{ago(ms(p.recorded_at), now)}</td>
                  </tr>
                );
              })}
              {!live.prs.length && (
                <tr>
                  <td colSpan={5} className="faint">
                    No pull requests recorded in the last 7 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Awaiting the seat" count={live.awaiting_seat.length} src="PRs auto-merge declined">
        <div className="scroll-x">
          <table className="list minw700">
            <thead>
              <tr>
                <th>PR</th>
                <th>Failed</th>
                <th>Why</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {live.awaiting_seat.map((a) => (
                <tr key={`${a.repo}-${a.number}`}>
                  <td className="mono">
                    <a href={`https://github.com/${a.repo}/pull/${a.number}`} target="_blank" rel="noopener noreferrer">
                      {a.repo} #{a.number}
                    </a>
                  </td>
                  <td>
                    <St kind="warn">{a.failed}</St>
                  </td>
                  <td className="muted">{a.why}</td>
                  <td className="mono">{ago(ms(a.at), now)}</td>
                </tr>
              ))}
              {!live.awaiting_seat.length && (
                <tr>
                  <td colSpan={4} className="faint">
                    Nothing is waiting on the seat.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
