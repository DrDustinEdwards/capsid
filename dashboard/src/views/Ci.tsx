import { AwayLink } from "capsomer/react/link";
import { trendChart } from "./charts";
import { Suspense } from "react";
import { useApp } from "../app/ctx";
import { KIND_STATUS, ciState } from "../lib/derive";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import { Status } from "capsomer/react/status";
import { Panel } from "capsomer/react/panel";
import { NoSnapshot } from "./shared";

// Chart 11, each default branch by day for 14 days, from GET /portal/api/trends. Lazy, so
// Enarratio loads only when the chart is drawn.
const CiHistory = trendChart("CiHistory");

// CI's default-branch table, a section of Health (design-portal-evaluation.md section 2).
export function DefaultBranches() {
  const { feed, now } = useApp();
  const snap = feed.snapshot;
  return (
    <>
      <Panel flush title="Default branches">
        {snap ? (
          <div className="cap-table-wrap">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>Project</th>
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
                    // The whole row opens the run (the UX audit's m5: "run" was a 20 by 16 px target).
                    <tr key={c.namespace} className={c.latest?.url ? "click" : undefined}>
                      <td>
                        <b>{c.namespace}</b>
                      </td>
                      <td>
                        <Status {...KIND_STATUS[st.kind]}>{st.label}</Status>
                      </td>
                      <td className="cap-mono">{c.latest ? c.latest.head_sha.slice(0, 7) : "-"}</td>
                      <td
                        className="cap-num"
                        title={c.latest ? utc(parse(c.latest.created_at)) : undefined}
                      >
                        {c.latest ? (
                          ago(parse(c.latest.created_at), now)
                        ) : (
                          <span className="cap-text" data-tone="dim">
                            runs could not be read
                          </span>
                        )}
                      </td>
                      <td>
                        {c.latest?.url && (
                          <AwayLink
                            className="cap-table-open"
                            href={c.latest.url}
                            aria-label={`Open the latest ${c.namespace} run on GitHub`}
                            newTab
                          >
                            Open run
                          </AwayLink>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <NoSnapshot />
        )}
      </Panel>
      <Suspense fallback={null}>
        <CiHistory />
      </Suspense>
    </>
  );
}
