import { AwayLink } from "capsomer/react/link";
import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { useApp } from "../app/ctx";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

function prLabel(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[1]} #${m[2]}` : url;
}

const MergesChart = trendChart("MergesChart");

export function PullRequests() {
  const { feed, now } = useApp();
  const live = feed.live;
  return (
    <div className="cap-admin-page">
      <PageHead title="Pull requests" />
      <Panel flush title="Pull requests, last 7 days" count={live.prs.length}>
        <div className="cap-table-wrap" data-reflow="wide">
          <table className="cap-table">
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
                  <tr
                    key={`${p.job_id}-${p.pr_url}`}
                    className={job ? "click" : undefined}
                    data-row=""
                    data-open={job ? `job:${job.id}` : undefined}
                    tabIndex={job ? 0 : undefined}
                  >
                    <td className="cap-mono">
                      <AwayLink href={p.pr_url} newTab>
                        {prLabel(p.pr_url)}
                      </AwayLink>
                    </td>
                    <td data-label="Job">
                      {job ? (
                        job.title
                      ) : (
                        <span className="cap-text cap-mono" data-tone="dim">
                          {p.job_id}
                        </span>
                      )}
                    </td>
                    <td data-label="State">
                      {p.merged === true ? (
                        <Status tone="ok">Merged</Status>
                      ) : p.merged === false ? (
                        <Status tone="crit">Not merged</Status>
                      ) : (
                        <Status tone="info" running>
                          Open
                        </Status>
                      )}
                    </td>
                    <td className="cap-num" data-label="Verified">
                      {p.merge_verified_at ? (
                        ago(parse(p.merge_verified_at), now)
                      ) : (
                        <span className="cap-text" data-tone="dim">
                          not yet
                        </span>
                      )}
                    </td>
                    <td className="cap-num" data-label="Recorded">
                      {ago(parse(p.recorded_at), now)}
                    </td>
                  </tr>
                );
              })}
              {!live.prs.length && (
                <tr>
                  <td colSpan={5} className="cap-text" data-tone="dim">
                    None in 7 days.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <ChartSlot>
        <MergesChart />
      </ChartSlot>
    </div>
  );
}
