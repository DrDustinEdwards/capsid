import { useEffect, useState } from "react";
import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { fetchMaintenance } from "../lib/api";
import type { Kind } from "../lib/derive";
import { ago, ms } from "../lib/format";
import type { MaintenanceRule, OpsMaintenanceItem, PortalMaintenance } from "../types";
import { St } from "../ui/icons";

// The Maintenance list on the Overview (job_549550d73d4e): what the daily maintenance pass
// found, from GET /portal/api/maintenance, the list improve_status serves. The seat reads
// it at the start of a session. Loaded on its own, after the Overview, so the first paint
// does not carry it. Nothing here changes anything: a row naming a job in the feed opens
// that job's drawer, and a pull request is a link.

// What to do first: something broken, then something waiting on the seat, then tidying,
// then what the pass did on its own, and last what it could not read.
const RULE: Record<MaintenanceRule, { kind: Kind; label: string; order: number }> = {
  "pr-red": { kind: "crit", label: "Red PR", order: 0 },
  "disk-low": { kind: "crit", label: "Low disk", order: 1 },
  "undeployed-merge": { kind: "warn", label: "Not deployed", order: 2 },
  "pr-awaiting-seat": { kind: "warn", label: "PR waiting", order: 3 },
  "shipped-elsewhere": { kind: "warn", label: "Shipped", order: 4 },
  "followups-missing": { kind: "warn", label: "Follow-ups", order: 5 },
  "later-passed": { kind: "warn", label: "Date passed", order: 6 },
  "branch-merged": { kind: "warn", label: "Merged branch", order: 7 },
  "branch-stale": { kind: "warn", label: "Old branch", order: 8 },
  "auto-resumed": { kind: "ok", label: "Resumed", order: 9 },
  "branch-pruned": { kind: "ok", label: "Pruned", order: 10 },
  "prs-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "branches-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "disk-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
  "deploys-not-checked": { kind: "nodata", label: "Not checked", order: 11 },
};

// Rows shown before "more"; every critical row is shown.
const ROWS = 8;

type Load = { data: PortalMaintenance | null; loading: boolean; error: string | null };

export function Maintenance() {
  const { feed, now, signOut } = useApp();
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoad((l) => ({ ...l, loading: true }));
    void fetchMaintenance().then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setLoad({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      const message = r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message;
      setLoad((l) => ({ ...l, loading: false, error: message }));
    });
    return () => {
      alive = false;
    };
  }, [tick, signOut]);

  const data = load.data;
  const items = data ? [...data.items].sort((a, b) => RULE[a.rule].order - RULE[b.rule].order) : [];
  const crit = items.filter((i) => RULE[i.rule].kind === "crit").length;
  const shown = more ? items : items.slice(0, Math.max(ROWS, crit));
  const hidden = items.length - shown.length;
  const open = new Set(feed.live.jobs.map((j) => j.id));
  const r = data?.read;
  const readLine = r ? `${r.repos} of ${r.roster} repos, ${r.prs} open PRs, ${r.branches} branches, ${r.deploys} live deploys, ${r.disk} driver disk readings read` : "";
  return (
    <Panel
      flush
      title="Maintenance"
      id="maintenance"
      section="Maintenance"
      count={data?.generated ? items.length : undefined}
      src={
        <>
          {data?.generated ? `daily pass ${ago(ms(data.generated), now)} · ` : ""}
          <button type="button" className="btn" disabled={load.loading} onClick={() => setTick((t) => t + 1)}>
            {load.loading ? "Reading..." : "Read again"}
          </button>
        </>
      }
    >
      {load.error && (
        <div className="callout crit" role="alert">
          Could not read the Maintenance list: {load.error}
        </div>
      )}
      {!data && load.loading ? (
        <div className="loading" role="status">
          <Spinner label="Reading the Maintenance list..." />
        </div>
      ) : data && !data.generated ? (
        <div className="body faint">The daily pass has not run yet. It runs once a day after 11:00 UTC.</div>
      ) : items.length ? (
        <>
          {shown.map((i, n) => (
            <Row key={`${i.rule}|${n}`} item={i} opens={i.job !== null && open.has(i.job)} />
          ))}
          {(hidden > 0 || more) && (
            <div className="att-more">
              <button type="button" className="linkbtn" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? "Fewer" : `${hidden} more`}
              </button>
            </div>
          )}
          <div className="mt-read faint">{readLine}</div>
        </>
      ) : data ? (
        <>
          <Empty kind="all-clear" title="Nothing to maintain." />
          <div className="mt-read faint">{readLine}</div>
        </>
      ) : (
        <div className="body faint">No read yet.</div>
      )}
    </Panel>
  );
}

function Row({ item, opens }: { item: OpsMaintenanceItem; opens: boolean }) {
  const rule = RULE[item.rule];
  const target = opens ? { "data-row": "", "data-open": `job:${item.job}`, tabIndex: 0 } : {};
  return (
    <div className={rule.kind === "crit" ? "qrow mrow sev-crit" : "qrow mrow"} data-rule={item.rule} {...target}>
      <St kind={rule.kind}>{rule.label}</St>
      <div className="t">
        <div className="why">{item.line}</div>
        {item.pr && (
          <a href={item.pr} target="_blank" rel="noreferrer">
            {item.pr.replace(/^https:\/\/github\.com\//, "")}
          </a>
        )}
      </div>
      <div className="m">
        <span className="ns">{item.namespace}</span>
      </div>
    </div>
  );
}
