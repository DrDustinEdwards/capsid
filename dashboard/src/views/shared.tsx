import { trendChart } from "./charts";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useCallback, type ReactNode } from "react";
import { useLocation, useSearchString } from "../lib/router";
import { useApp } from "../app/ctx";
import { hasSites } from "../lib/derive";
import { incidents } from "../lib/incidents";
import { DAY } from "../lib/format";
import { Glyph, Status } from "capsomer/react/status";
import { ChartSlot } from "../ui/ChartSlot";

const DeployTimeline = trendChart("DeployTimeline");

export function PageHead({ title }: { title: string }) {
  return (
    <div className="pagehead">
      <h1>{title}</h1>
    </div>
  );
}

export function useNsFilter(): [string, (ns: string) => void] {
  const search = useSearchString();
  const [location, navigate] = useLocation();
  const ns = new URLSearchParams(search).get("ns") || "all";
  const set = useCallback(
    (next: string) => {
      const qs = new URLSearchParams(search);
      if (next === "all") qs.delete("ns");
      else qs.set("ns", next);
      const q = qs.toString();
      navigate(q ? `${location}?${q}` : location, { replace: true });
    },
    [search, location, navigate],
  );
  return [ns, set];
}

export function NsChips({ list }: { list: string[] }) {
  const [ns, setNs] = useNsFilter();
  const all = ["all", ...new Set(list)];
  if (!all.includes(ns)) all.push(ns);
  return (
    <div className="cap-cluster" data-gap="3" role="group" aria-label="Filter by namespace">
      {all.map((n) => (
        <button
          key={n}
          type="button"
          className="cap-chip"
          aria-pressed={ns === n}
          onClick={() => setNs(n)}
        >
          {n === "all" ? "All" : n}
        </button>
      ))}
    </div>
  );
}

export function ProjectSelect({
  id,
  value,
  applied,
  onChange,
}: {
  id: string;
  value: string;
  applied: string;
  onChange: (namespace: string) => void;
}) {
  const { feed } = useApp();
  const names = feed.live.namespaces.map((n) => n.name);
  if (applied && !names.includes(applied)) names.push(applied);
  return (
    <>
      <label className="cap-sr-only" htmlFor={id}>
        Project
      </label>
      <select
        id={id}
        name="namespace"
        className="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All projects</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </>
  );
}

export function FilterEmpty({
  children,
  onShowAll,
}: {
  children: ReactNode;
  onShowAll: () => void;
}) {
  return (
    <div role="status" data-filter-empty="">
      <Empty
        kind="no-match"
        title={children}
        action={
          <button type="button" className="cap-btn" onClick={onShowAll}>
            Show all
          </button>
        }
      />
    </div>
  );
}

export function NoSnapshot() {
  return <Empty kind="nothing-yet" title={<Status tone="nodata">No watcher pass yet</Status>} />;
}

export function IncidentFeed({ ns }: { ns?: string }) {
  const { feed, now } = useApp();
  let items = incidents(feed);
  if (ns && ns !== "all") items = items.filter((x) => x.ns === ns);
  if (!items.length)
    return <Empty kind="all-clear" title="No watcher findings in the live window." />;
  const oldest = Math.max(DAY, ...items.map((it) => now - it.at));
  return (
    <div className="feed">
      {items.map((it) => {
        const kind = it.open ? it.sev : "ok";
        const open = Math.max(0, now - it.at);
        return (
          <div
            className={kind === "crit" ? "frow sev-crit" : "frow"}
            key={`${it.fp}-${it.ref ?? ""}`}
            data-row=""
            data-open={it.ref ?? undefined}
            role={it.ref ? "button" : undefined}
            tabIndex={it.ref ? 0 : undefined}
            title={it.ref ? undefined : `fingerprint ${it.fp}`}
          >
            <Glyph name={kind} tone={kind} />
            <div className="t">
              <b>{it.title}</b>
              <div className="sub">
                <span className="ns">{it.ns}</span> ·{" "}
                {it.status === "open" ? (it.open ? "open" : "closed") : it.status}
              </div>
            </div>
            <div className="m">
              {(open / DAY).toFixed(1)} days open
              <svg
                className="age-bar"
                viewBox="0 0 100 6"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect width={Math.max(2, (open / oldest) * 100)} height="6" data-tone={kind} />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TimelinePanel({
  title,
  days,
  src,
  id,
  section,
}: {
  title: string;
  days: number;
  src?: string;
  id?: string;
  section?: string;
}) {
  const { feed } = useApp();
  const sites = hasSites(feed) ? (feed.snapshot?.sites ?? []) : [];
  return (
    <Panel flush title={title} src={src} id={id} section={section}>
      {!hasSites(feed) ? (
        <div className="cap-text body" data-tone="dim">
          No site configured.
        </div>
      ) : sites.length ? (
        <div className="body">
          <ChartSlot>
            <DeployTimeline sites={sites} days={days} />
          </ChartSlot>
        </div>
      ) : (
        <NoSnapshot />
      )}
    </Panel>
  );
}
