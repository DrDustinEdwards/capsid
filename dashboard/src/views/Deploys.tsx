import { useState } from "react";
import { useApp } from "../app/ctx";
import type { CfDeploy, SiteSnapshot } from "../types";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { DAY, ago, shortId } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import { Panel } from "capsomer/react/panel";
import { ChartSlot } from "../ui/ChartSlot";
import { trendChart } from "./charts";
import { NoSnapshot, NsChips, TimelinePanel, useNsFilter } from "./shared";

const DeploysTable = trendChart("DeploysTable");

const RANGES = ["24h", "7d", "30d"] as const;

export function Deploys() {
  const { feed, now } = useApp();
  const [range, setRange] = useState<(typeof RANGES)[number]>("7d");
  const [ns, setNs] = useNsFilter();
  const snap = feed.snapshot;
  const days = range === "24h" ? 1 : range === "30d" ? 30 : 7;
  const rows: Array<{ s: SiteSnapshot; d: CfDeploy }> = [];
  for (const s of snap?.sites ?? []) for (const d of cfOk(s)?.deploys ?? []) rows.push({ s, d });
  const list = rows
    .filter(
      (x) => now - parse(x.d.created_on) < days * DAY && (ns === "all" || x.s.namespace === ns),
    )
    .sort((a, b) => parse(b.d.created_on) - parse(a.d.created_on));
  const missing = (snap?.sites ?? []).filter((s) => !cfOk(s));
  return (
    <div className="cap-stack">
      <div className="cap-cluster" data-gap="3">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className="cap-chip"
            aria-pressed={range === r}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
        <span className="cap-text" data-tone="dim">
          range
        </span>
      </div>
      <TimelinePanel
        title="Timeline"
        id="timeline"
        section="Timeline"
        days={days}
        src={days > 7 ? "the probe ring holds 7 days; older downtime is not shown" : undefined}
      />
      {snap ? (
        <>
          <NsChips list={snap.sites.map((s) => s.namespace)} />
          <Panel
            flush
            title="Every deploy"
            id="every-deploy"
            section="Every deploy"
            count={list.length}
            src="at most 10 per site"
          >
            <div className="cap-table-wrap">
              <table className="cap-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Site</th>
                    <th>Version</th>
                    <th>Message</th>
                    <th>Triggered by</th>
                    <th>Author</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(({ s, d }) => (
                    <tr
                      key={`${siteKey(s)}-${d.id}`}
                      data-row=""
                      data-open={`site:${siteKey(s)}`}
                      tabIndex={0}
                    >
                      <td className="cap-num" title={utc(parse(d.created_on))}>
                        {ago(parse(d.created_on), now)}
                      </td>
                      <td>
                        <b>{s.name}</b>
                      </td>
                      <td className="cap-mono">
                        {d.version_id ? (
                          shortId(d.version_id)
                        ) : (
                          <span className="cap-text" data-tone="dim">
                            none recorded
                          </span>
                        )}
                      </td>
                      <td className="cap-muted">{d.message ?? ""}</td>
                      <td className="cap-muted">{d.triggered_by ?? ""}</td>
                      <td className="cap-muted">{d.author_email ?? ""}</td>
                    </tr>
                  ))}
                  {!list.length && (
                    <tr>
                      <td colSpan={6} className="cap-text" data-tone="dim">
                        {ns === "all" ? (
                          "No deploys in this range."
                        ) : (
                          <span
                            className="cap-cluster"
                            data-gap="3"
                            role="status"
                            data-filter-empty=""
                          >
                            No deploys for the namespace {ns} in this range.
                            <button type="button" className="cap-btn" onClick={() => setNs("all")}>
                              Show all
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          {missing.length > 0 && (
            <Panel
              flush
              title="Sites with no deploy data"
              id="no-deploy-data"
              section="No deploy data"
              count={missing.length}
            >
              <div className="cap-table-wrap">
                <table className="cap-table">
                  <tbody>
                    {missing.map((s) => (
                      <tr key={siteKey(s)}>
                        <td>
                          <b>{s.name}</b>
                        </td>
                        <td className="cap-muted">{cfNoData(s.cloudflare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      ) : (
        <NoSnapshot />
      )}
      <ChartSlot>
        <DeploysTable />
      </ChartSlot>
    </div>
  );
}
