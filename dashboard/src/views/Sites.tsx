import { useState } from "react";
import { SITES_TABS, sitePath, tabOf, useApp } from "../app/ctx";
import { Link } from "../lib/router";
import { pct } from "../lib/format";
import { St } from "../ui/icons";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Panel } from "capsomer/react/panel";
import "capsomer/uptime-strip.css";
import { uptimeStrip, type UptimeSlot } from "enarratio";
import { Deploys } from "./Deploys";
import { SiteForm, SiteRow, type Editing } from "./SiteConfig";
import { FilterEmpty, FleetTable, NoSnapshot, NsChips, PageHead, useNsFilter } from "./shared";

// SITES (the Portal audit's new map, 2026-11-06): every site in one table, its status, uptime,
// live deploy, errors and backup age, with Add site; then each site's uptime by month. A row
// opens the site's own page (views/SitePage.tsx). The Deploys tab holds every site's deploys.
// Projects recorded as serving no site are listed last, so that record can be changed too.
export function Sites() {
  const tab = tabOf(SITES_TABS, useTabParam()) ?? SITES_TABS[0].id;
  return (
    <div className="page">
      <PageHead title="Sites" />
      <PageTabs label="Sites" path="/sites" tabs={SITES_TABS} current={tab} />
      {tab === "deploys" ? <Deploys /> : <AllSites />}
    </div>
  );
}

function AllSites() {
  const { feed } = useApp();
  const [ns, setNs] = useNsFilter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const snap = feed.snapshot;
  const configured = feed.live.sites;
  const noSite = configured.filter((s) => s.origin === null);
  // The form is keyed on what it edits, so switching rows starts a fresh draft.
  const formKey = editing ? (editing.kind === "add" ? "add" : `edit:${editing.row.namespace}`) : "";
  const list = (snap?.sites ?? []).filter((s) => ns === "all" || s.namespace === ns);
  const emptied = !!snap && !list.length && snap.sites.length > 0;
  // A site added since the watcher's last pass has a row but no probe yet.
  const probed = new Set((snap?.sites ?? []).map((s) => s.namespace));
  const waiting = configured.filter((s) => s.origin !== null && !probed.has(s.namespace));
  return (
    <div className="embedded">
      <div className="toolbar">
        <button type="button" className="btn primary" onClick={() => setEditing({ kind: "add" })} disabled={editing?.kind === "add"}>
          Add site
        </button>
        {snap && <NsChips list={snap.sites.map((s) => s.namespace)} />}
      </div>
      {editing && <SiteForm key={formKey} editing={editing} onClose={() => setEditing(null)} />}
      {!configured.some((s) => s.origin !== null) ? (
        <div className="callout" role="status">
          No site is configured, so the watcher probes nothing. Add a site to start.
        </div>
      ) : !snap ? (
        <NoSnapshot />
      ) : (
        <Panel flush title="Every site" count={snap.sites.length}>
          {emptied ? <FilterEmpty onShowAll={() => setNs("all")}>No site in the project {ns}.</FilterEmpty> : <FleetTable sites={list} />}
        </Panel>
      )}
      {waiting.length > 0 && (
        <div className="callout" role="status">
          Added and waiting for the watcher's next pass:{" "}
          {waiting.map((s, i) => (
            <span key={s.namespace}>
              {i > 0 ? ", " : ""}
              <Link href={sitePath(s.namespace)}>{s.name}</Link>
            </span>
          ))}
          .
        </div>
      )}
      <Uptime90 ns={ns} />
      {noSite.length > 0 && (
        <Panel flush title="Projects with no site" count={noSite.length}>
          <div className="scroll-x reflow">
            <table className="list cards-below-1100">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Name</th>
                  <th>Origin</th>
                  <th>Health path</th>
                  <th>Platform</th>
                  <th>Worker script</th>
                  <th>Revision</th>
                  <th>
                    <span className="sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {noSite.map((s) => (
                  <SiteRow key={s.namespace} s={s} onEdit={() => setEditing({ kind: "edit", row: s })} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

// Each site's last 90 UTC days against the 99.9% target, from the five-minute pulse's daily
// counts (ops_uptime_daily), drawn as Capsomer's uptime strip in its table-cell form with one
// slot per UTC month (U4): up when the month met the target, degraded under it, down when no
// probe answered, the percent beside it. Degraded counts as up: the site answered.
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const monthName = (m: string) => MONTH.format(new Date(`${m}-01T00:00:00Z`));

export function Uptime90({ ns }: { ns: string }) {
  const { feed } = useApp();
  const u = feed.uptime;
  const title = u ? `Uptime by month, ${u.days} days` : "Uptime by month, 90 days";
  const src = u ? `target ${pct(u.target, 1)}, five-minute probes` : "five-minute probes";
  if (u === undefined) return null;
  if (u === null) {
    return (
      <Panel title={title} src={src}>
        <St kind="nodata">No data</St> The daily counts could not be read.
      </Panel>
    );
  }
  const rows = u.sites.filter((s) => ns === "all" || s.namespace === ns);
  return (
    <Panel flush title={title} src={src}>
      {rows.length === 0 ? (
        <p className="faint">No probe counted yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr>
                <th>Site</th>
                <th>Uptime by month</th>
                <th>Days counted</th>
                <th>Days under target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const share = s.probes > 0 ? s.up / s.probes : null;
                const slots: UptimeSlot[] = (s.months ?? []).map((m) => {
                  const r = m.probes > 0 ? m.up / m.probes : null;
                  const status = r === null ? "unknown" : m.up === 0 ? "down" : r >= u.target ? "up" : "degraded";
                  return { status, label: `${monthName(m.month)}: ${r === null ? "no probe" : `${pct(r, 2)} of ${m.probes} probes up, ${m.below} of ${m.days} days under target`}` };
                });
                const alt = `Uptime of ${s.namespace} by month: ${(s.months ?? []).map((m) => `${monthName(m.month)} ${m.probes ? pct(m.up / m.probes, 2) : "no data"}`).join(", ")}.`;
                return (
                  <tr key={s.namespace}>
                    <td>
                      <b>{s.namespace}</b>
                    </td>
                    <td>
                      {share === null ? (
                        <St kind="nodata">No data</St>
                      ) : (
                        <span className="cap-uptime-line">
                          <span className="cap-uptime-strip" dangerouslySetInnerHTML={{ __html: uptimeStrip({ slots, alt, inline: true, width: 120, height: 18 }) }} />
                          <span className="cap-uptime-pct">
                            <St kind={share >= u.target ? "ok" : "warn"}>{pct(share, 2)}</St>
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="num">{s.days}</td>
                    <td className="num">{s.below}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="cap-uptime-legend" aria-label="Key">
            <li><span className="cap-uptime-key" data-key="up" aria-hidden="true"></span>Met target</li>
            <li><span className="cap-uptime-key" data-key="degraded" aria-hidden="true"></span>Under target</li>
            <li><span className="cap-uptime-key" data-key="down" aria-hidden="true"></span>Down</li>
            <li><span className="cap-uptime-key" data-key="nodata" aria-hidden="true"></span>No data</li>
          </ul>
        </div>
      )}
    </Panel>
  );
}

