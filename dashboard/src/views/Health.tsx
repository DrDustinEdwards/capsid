import type { ReactNode } from "react";
import { useApp } from "../app/ctx";
import { hasSites } from "../lib/derive";
import { Anchors } from "../ui/anchors";
import { Backups } from "./Backups";
import { DefaultBranches } from "./Ci";
import { Deploys } from "./Deploys";
import { Incidents } from "./Incidents";
import { Overview } from "./Overview";
import { Sites } from "./Sites";
import { PageHead } from "./shared";

// HEALTH (docs/design/design-portal-evaluation.md section 2, DECIDE 2, ruled 2026-10-09;
// job_d62abdbfc270 PR 2): "is anything broken" on one page. The Overview's tiles and the
// maintenance list first, then the sections that were their own views: Sites (only while
// one is configured), Incidents, Deploys, Backups, and CI's default branches. Each view
// renders embedded, so nothing it showed is lost (conventions 1.3); the one namespace
// filter in the address (?ns=) narrows every section at once.

// label: the section's name in the anchor bar, when the heading is longer.
function Section({ id, title, label = title, children }: { id: string; title: string; label?: string; children: ReactNode }) {
  const headingId = `${id}-h`;
  return (
    <section className="health-section" id={id} data-section={label} aria-labelledby={headingId}>
      <h2 className="health-title" id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Health() {
  const { feed } = useApp();
  const sitesOn = hasSites(feed);
  return (
    <div className="page">
      <Anchors />
      <PageHead title="Health" />
      <Overview />
      {sitesOn && (
        <Section id="sites" title="Sites">
          <Sites embedded />
        </Section>
      )}
      <Section id="incidents" title="Incidents">
        <Incidents embedded />
      </Section>
      <Section id="deploys" title="Deploys">
        <Deploys embedded />
      </Section>
      <Section id="backups" title="Backups">
        <Backups embedded />
      </Section>
      <Section id="ci" title="CI, default branches" label="CI">
        <DefaultBranches />
      </Section>
    </div>
  );
}
