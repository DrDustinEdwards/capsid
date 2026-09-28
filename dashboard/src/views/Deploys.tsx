import { useApp, type Filters } from "../app/ctx";
import type { CfDeploy, SiteSnapshot } from "../types";
import { cfNoData, cfOk, siteKey } from "../lib/derive";
import { DAY, ago, ms, shortId, utc } from "../lib/format";
import { NoSnapshot, NsChips, PageHead, Panel, TimelinePanel } from "./shared";

const RANGES: Array<Filters["range"]> = ["24h", "7d", "30d"];

export function Deploys() {
  const { feed, now, filters, setFilters } = useApp();
  const snap = feed.snapshot;
  const days = filters.range === "24h" ? 1 : filters.range === "30d" ? 30 : 7;
  const rows: Array<{ s: SiteSnapshot; d: CfDeploy }> = [];
  for (const s of snap?.sites ?? []) for (const d of cfOk(s)?.deploys ?? []) rows.push({ s, d });
  const list = rows
    .filter((x) => now - ms(x.d.created_on) < days * DAY && (filters.ns === "all" || x.s.namespace === filters.ns))
    .sort((a, b) => ms(b.d.created_on) - ms(a.d.created_on));
  const missing = (snap?.sites ?? []).filter((s) => !cfOk(s));
  return (
    <div className="page">
      <PageHead title="Deploys">What serves traffic on every Worker, from Cloudflare's own record, so a hand-run wrangler deploy shows up too.</PageHead>
      <div className="toolbar">
        {RANGES.map((r) => (
          <button key={r} type="button" className="chip" aria-pressed={filters.range === r} onClick={() => setFilters({ range: r })}>
            {r}
          </button>
        ))}
        <span className="faint ml6">range</span>
      </div>
      <TimelinePanel title="Timeline" days={days} src={days > 7 ? "the probe ring holds 7 days; older downtime is not shown" : "deploys and probe failures"} />
      {snap ? (
        <>
          <NsChips list={snap.sites.map((s) => s.namespace)} />
          <Panel title="Every deploy" count={list.length} src="at most 10 per site, newest first">
            <div className="scroll-x">
              <table className="list minw760">
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
                      <td className="mono" title={utc(ms(d.created_on))}>
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
                        No deploys in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          {missing.length > 0 && (
            <Panel title="Sites with no deploy data" count={missing.length}>
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
