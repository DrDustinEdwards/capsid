import { useApp, type Filters } from "../app/ctx";
import type { CfDeploy, SiteSnapshot } from "../types";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { DAY, ago, ms, shortId, utc } from "../lib/format";
import { Anchors } from "../ui/anchors";
import { NoSnapshot, NsChips, PageHead, Panel, TimelinePanel, useNsFilter } from "./shared";

const RANGES: Array<Filters["range"]> = ["24h", "7d", "30d"];

export function Deploys() {
  const { feed, now, filters, setFilters } = useApp();
  const [ns, setNs] = useNsFilter();
  const snap = feed.snapshot;
  const days = filters.range === "24h" ? 1 : filters.range === "30d" ? 30 : 7;
  const rows: Array<{ s: SiteSnapshot; d: CfDeploy }> = [];
  for (const s of snap?.sites ?? []) for (const d of cfOk(s)?.deploys ?? []) rows.push({ s, d });
  const list = rows
    .filter((x) => now - ms(x.d.created_on) < days * DAY && (ns === "all" || x.s.namespace === ns))
    .sort((a, b) => ms(b.d.created_on) - ms(a.d.created_on));
  const missing = (snap?.sites ?? []).filter((s) => !cfOk(s));
  return (
    <div className="page">
      <Anchors />
      <PageHead title="Deploys" />
      <div className="toolbar">
        {RANGES.map((r) => (
          <button key={r} type="button" className="chip" aria-pressed={filters.range === r} onClick={() => setFilters({ range: r })}>
            {r}
          </button>
        ))}
        <span className="faint ml6">range</span>
      </div>
      <TimelinePanel title="Timeline" id="timeline" section="Timeline" days={days} src={days > 7 ? "the probe ring holds 7 days; older downtime is not shown" : "deploys and probe failures"} />
      {snap ? (
        <>
          <NsChips list={snap.sites.map((s) => s.namespace)} />
          <Panel title="Every deploy" id="every-deploy" section="Every deploy" count={list.length} src="at most 10 per site, newest first">
            <div className="scroll-x">
              <table className="list">
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
                    <tr key={`${siteKey(s)}-${d.id}`} className="click" data-row="" data-open={`site:${siteKey(s)}`} tabIndex={0}>
                      <td className="num" title={utc(ms(d.created_on))}>
                        {ago(ms(d.created_on), now)}
                      </td>
                      <td>
                        <b>{s.name}</b>
                      </td>
                      <td className="mono">{d.version_id ? shortId(d.version_id) : <span className="faint">none recorded</span>}</td>
                      <td className="muted">{d.message ?? ""}</td>
                      <td className="muted">{d.triggered_by ?? ""}</td>
                      <td className="muted">{d.author_email ?? ""}</td>
                    </tr>
                  ))}
                  {!list.length && (
                    <tr>
                      <td colSpan={6} className="faint">
                        {ns === "all" ? (
                          "No deploys in this range."
                        ) : (
                          <span className="toolbar" role="status" data-filter-empty="">
                            No deploys for the namespace {ns} in this range.
                            <button type="button" className="btn" onClick={() => setNs("all")}>
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
            <Panel title="Sites with no deploy data" id="no-deploy-data" section="No deploy data" count={missing.length}>
              <div className="scroll-x">
                <table className="list">
                  <tbody>
                    {missing.map((s) => (
                      <tr key={siteKey(s)}>
                        <td>
                          <b>{s.name}</b>
                        </td>
                        <td className="muted">{cfNoData(s.cloudflare)}</td>
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
    </div>
  );
}
