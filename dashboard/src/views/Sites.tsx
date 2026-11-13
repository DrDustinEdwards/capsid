import { Banner } from "capsomer/react/banner";
import type { OpsSiteConfig } from "../types";
import { SITES_TABS, sitePath, tabOf, useApp } from "../app/ctx";
import { Link } from "../lib/router";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { Panel } from "capsomer/react/panel";
import { Uptime90 } from "./Uptime90";
import { Deploys } from "./Deploys";
import { useEditor } from "capsomer/react/config-form";
import { SiteForm, SiteRow } from "./SiteConfig";
import { FilterEmpty, FleetTable, NoSnapshot, NsChips, PageHead, useNsFilter } from "./shared";

// SITES (the Portal audit's new map, 2026-11-06): every site in one table, its status, uptime,
// live deploy, errors and backup age, with Add site; then each site's uptime by month. A row
// opens the site's own page (views/SitePage.tsx). The Deploys tab holds every site's deploys.
// Projects recorded as serving no site are listed last, so that record can be changed too.
export function Sites() {
  const tab = tabOf(SITES_TABS, useTabParam()) ?? SITES_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Sites" />
      <PageTabs label="Sites" path="/sites" tabs={SITES_TABS} current={tab} />
      {tab === "deploys" ? <Deploys /> : <AllSites />}
    </div>
  );
}

function AllSites() {
  const { feed } = useApp();
  const [ns, setNs] = useNsFilter();
  const ed = useEditor<OpsSiteConfig>();
  const snap = feed.snapshot;
  const configured = feed.live.sites;
  const noSite = configured.filter((s) => s.origin === null);
  const list = (snap?.sites ?? []).filter((s) => ns === "all" || s.namespace === ns);
  const emptied = !!snap && !list.length && snap.sites.length > 0;
  // A site added since the watcher's last pass has a row but no probe yet.
  const probed = new Set((snap?.sites ?? []).map((s) => s.namespace));
  const waiting = configured.filter((s) => s.origin !== null && !probed.has(s.namespace));
  return (
    <div className="embedded">
      <div className="cap-cluster" data-gap="3">
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          onClick={ed.add}
          disabled={ed.editing?.kind === "add"}
        >
          Add site
        </button>
        {snap && <NsChips list={snap.sites.map((s) => s.namespace)} />}
      </div>
      {ed.editing && <SiteForm key={ed.formKey} editing={ed.editing} onClose={ed.close} />}
      {!configured.some((s) => s.origin !== null) ? (
        <Banner tone="neutral">
          No site is configured, so the watcher probes nothing. Add a site to start.
        </Banner>
      ) : !snap ? (
        <NoSnapshot />
      ) : (
        <Panel flush title="Every site" count={snap.sites.length}>
          {emptied ? (
            <FilterEmpty onShowAll={() => setNs("all")}>No site in the project {ns}.</FilterEmpty>
          ) : (
            <FleetTable sites={list} />
          )}
        </Panel>
      )}
      {waiting.length > 0 && (
        <Banner tone="neutral">
          Added and waiting for the watcher's next pass:{" "}
          {waiting.map((s, i) => (
            <span key={s.namespace}>
              {i > 0 ? ", " : ""}
              <Link href={sitePath(s.namespace)}>{s.name}</Link>
            </span>
          ))}
          .
        </Banner>
      )}
      <Uptime90 ns={ns} />
      {noSite.length > 0 && (
        <Panel flush title="Projects with no site" count={noSite.length}>
          <div className="cap-table-wrap" data-reflow="wide">
            <table className="cap-table">
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
                    <span className="cap-sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {noSite.map((s) => (
                  <SiteRow key={s.namespace} s={s} onEdit={() => ed.edit(s, s.namespace)} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
