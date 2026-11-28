import { Banner } from "capsomer/react/banner";
import { Row as CapRow, RowList } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import { AwayLink } from "capsomer/react/link";
import { useState } from "react";
import { Empty } from "capsomer/react/empty";
import { Spinner } from "capsomer/react/skeleton";
import { Panel } from "capsomer/react/panel";
import { ReadAgain } from "capsomer/react/read-state";
import { useApp } from "../app/ctx";
import { fetchMaintenance } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import type { Kind } from "../lib/derive";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { MaintenanceRule, OpsMaintenanceItem, PortalMaintenance } from "../types";
import { Status } from "capsomer/react/status";
import { KIND_STATUS } from "../lib/derive";

const RULE: Record<MaintenanceRule, { kind: Kind; label: string; order: number }> = {
  "pr-red": { kind: "crit", label: "Red PR", order: 0 },
  "undeployed-merge": { kind: "warn", label: "Not deployed", order: 2 },
  "branch-merged": { kind: "warn", label: "Merged branch", order: 7 },
  "branch-stale": { kind: "warn", label: "Old branch", order: 8 },
  "model-drift": { kind: "warn", label: "Model drift", order: 8 },
  "rule-doc": { kind: "warn", label: "Rule doc", order: 8 },
  "release-backwards": { kind: "warn", label: "Version behind", order: 8 },
  "release-untagged": { kind: "warn", label: "Untagged", order: 8 },
  "branch-pruned": { kind: "ok", label: "Pruned", order: 10 },
  "release-tagged": { kind: "ok", label: "Tagged", order: 10 },
  "prs-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "branches-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "deploys-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "model-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "rule-docs-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "releases-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
};

const ROWS = 8;

export function Maintenance() {
  const { now } = useApp();
  const [more, setMore] = useState(false);
  const load = useAnswer<PortalMaintenance>(["maintenance"], fetchMaintenance);

  const data = load.data;
  // A list stored before a rule was retired can still hold its items: they are not shown.
  const items = data
    ? data.items
        .filter((i) => Object.hasOwn(RULE, i.rule))
        .sort((a, b) => RULE[a.rule].order - RULE[b.rule].order)
    : [];
  const crit = items.filter((i) => RULE[i.rule].kind === "crit").length;
  const shown = more ? items : items.slice(0, Math.max(ROWS, crit));
  const hidden = items.length - shown.length;
  const r = data?.read;
  const readLine = r
    ? `${r.repos} of ${r.roster} repos, ${r.prs} open PRs, ${r.branches} branches, ${r.deploys} live deploys read`
    : "";
  return (
    <Panel
      flush
      title="Maintenance"
      id="maintenance"
      section="Maintenance"
      count={data?.generated ? items.length : undefined}
      src={
        <>
          {data?.generated ? `daily pass ${ago(parse(data.generated), now)} · ` : ""}
          <ReadAgain reading={load.loading} onRead={load.reread} />
        </>
      }
    >
      {load.error && <Banner tone="crit">Could not read the Maintenance list: {load.error}</Banner>}
      {!data && load.loading ? (
        <Spinner layout="page" label="Reading the Maintenance list..." />
      ) : data && !data.generated ? (
        <div className="cap-text body" data-tone="dim">
          Not run yet.
        </div>
      ) : items.length ? (
        <>
          <RowList label="Maintenance">
            {shown.map((i, n) => (
              <Row key={`${i.rule}|${n}`} item={i} />
            ))}
          </RowList>
          {(hidden > 0 || more) && (
            <div className="mt-read">
              <button
                type="button"
                className="cap-link-btn"
                aria-expanded={more}
                onClick={() => setMore(!more)}
              >
                {more ? "Fewer" : `${hidden} more`}
              </button>
            </div>
          )}
          <div className="cap-text mt-read" data-tone="dim">
            {readLine}
          </div>
        </>
      ) : data ? (
        <>
          <Empty kind="all-clear" title="Nothing to maintain." />
          <div className="cap-text mt-read" data-tone="dim">
            {readLine}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

function Row({ item }: { item: OpsMaintenanceItem }) {
  const rule = RULE[item.rule];
  return (
    <CapRow
      tone={rule.kind === "crit" ? "crit" : undefined}
      status={<Status {...KIND_STATUS[rule.kind]}>{rule.label}</Status>}
      title={item.line}
      meta={<span className="ns">{item.namespace}</span>}
      actions={
        item.pr ? (
          <AwayLink href={item.pr} newTab>
            {item.pr.replace(/^https:\/\/github\.com\//, "")}
          </AwayLink>
        ) : undefined
      }
    />
  );
}
