import { trendChart } from "./charts";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useCallback, type ReactNode } from "react";
import { rowLink, useLocation, useSearchString } from "../lib/router";
import { Group } from "capsomer/react/disclosure";
import { Row, RowList } from "capsomer/react/row-list";
import type { OpsJob } from "../types";
import { useApp } from "../app/ctx";
import { KIND_STATUS, JOB, jobBadge, blockedOrder, hasSites } from "../lib/derive";
import { incidents } from "../lib/incidents";
import { age, agentLabel, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
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

type QueueGroup = {
  id: string;
  label: string;
  pick: (jobs: OpsJob[], now: number) => OpsJob[];
  collapsed?: boolean;
  hideEmpty?: boolean;
};

const byStatus = (st: OpsJob["status"][]) => (jobs: OpsJob[]) =>
  jobs
    .filter((j) => st.includes(j.status))
    .sort((a, b) => parse(a.updated_at) - parse(b.updated_at));

const GROUPS: QueueGroup[] = [
  {
    id: "blocked",
    label: "Blocked, waiting on you",
    pick: (jobs, now) => blockedOrder(jobs, now).all,
  },
  { id: "running", label: "Running", pick: byStatus(["claimed"]) },
  {
    id: "queued",
    label: "Queued",
    pick: (jobs) =>
      jobs
        .filter((j) => j.status === "queued")
        .sort((a, b) => b.priority - a.priority || parse(a.updated_at) - parse(b.updated_at)),
  },
  // A button in the row would break its height (design D2).
  {
    id: "parked",
    label: "Parked",
    pick: (jobs) =>
      jobs
        .filter((j) => j.status === "parked")
        .sort((a, b) => b.priority - a.priority || parse(a.updated_at) - parse(b.updated_at)),
    hideEmpty: true,
  },
  {
    id: "done",
    label: "Done in the last 24h",
    pick: byStatus(["done"]),
    collapsed: true,
  },
  {
    id: "failed",
    label: "Failed or superseded, last 24h",
    pick: byStatus(["failed", "superseded"]),
    collapsed: true,
  },
];

export function jobMeta(j: OpsJob, now: number): string {
  switch (j.status) {
    case "blocked":
      return `waiting ${age(parse(j.updated_at), now)}`;
    case "claimed":
      return `claimed ${ago(parse(j.updated_at), now)}`;
    case "queued":
      return `queued ${ago(parse(j.created_at), now)}`;
    case "parked":
      return `parked ${ago(parse(j.updated_at), now)}`;
    default:
      return `${JOB[j.status].label.toLowerCase()} ${ago(parse(j.updated_at), now)}`;
  }
}

export function JobRow({
  job,
  status,
  detail,
  fact,
}: {
  job: { id: string; title: string; namespace: string };
  status: ReactNode;
  detail?: ReactNode;
  fact?: ReactNode;
}) {
  const { href } = useApp();
  return (
    <Row
      status={status}
      title={job.title}
      href={href(`job:${job.id}`)}
      detail={detail}
      // One box, so the break holds inside row-list's flex meta cell.
      meta={
        <span>
          <span className="ns">{job.namespace}</span>
          {fact != null && (
            <>
              <br />
              {fact}
            </>
          )}
        </span>
      }
      renderLink={rowLink}
    />
  );
}

export function QueueRows({ jobs }: { jobs: OpsJob[] }) {
  const { now, feed } = useApp();
  return (
    <>
      {GROUPS.map((g) => {
        const list = g.pick(jobs, now);
        if (g.hideEmpty && !list.length) return null;
        return (
          <div key={g.id} data-group={g.id}>
            <Group
              label={g.label}
              count={list.length}
              defaultExpanded={!g.collapsed}
              headingLevel={3}
              body="list"
            >
              {list.length ? (
                <RowList label={g.label}>
                  {list.map((j) => {
                    const pr = feed.live.prs.find((p) => p.job_id === j.id);
                    const sub =
                      j.status === "blocked" && j.question
                        ? `Asks: ${(j.waits_on ?? "no question recorded").replace(/^QUESTION:\s*/, "")}`
                        : j.status === "blocked"
                          ? `Waits on: ${j.waits_on ?? "no reason recorded"}`
                          : j.status === "parked"
                            ? `Comes back: ${j.parked_reason ?? "no reason recorded"}`
                            : j.status === "claimed"
                              ? `Held by ${j.claimed_by ? agentLabel(j.claimed_by) : "no holder"}`
                              : j.status === "queued"
                                ? `${j.finding ? "Watcher finding · " : ""}${j.started_by && j.started_at ? `Started by ${agentLabel(j.started_by)} ${ago(parse(j.started_at), now)} · ` : ""}priority ${j.priority}`
                                : `${pr ? `PR #${pr.pr_url.split("/").slice(-1)[0]} · ` : ""}${j.claimed_by ? agentLabel(j.claimed_by) : "no holder"}`;
                    const k =
                      j.status === "blocked" && j.question
                        ? { kind: JOB.blocked.kind, label: "Question" }
                        : jobBadge(j, now);
                    return (
                      <JobRow
                        key={j.id}
                        job={j}
                        status={<Status {...KIND_STATUS[k.kind]}>{k.label}</Status>}
                        detail={sub}
                        fact={jobMeta(j, now)}
                      />
                    );
                  })}
                </RowList>
              ) : (
                <div className="cap-text mt-read" data-tone="dim">
                  None
                </div>
              )}
            </Group>
          </div>
        );
      })}
    </>
  );
}

export function IncidentFeed({ ns }: { ns?: string }) {
  const { feed, now } = useApp();
  let items = incidents(feed);
  if (ns && ns !== "all") items = items.filter((x) => x.ns === ns);
  if (!items.length)
    return <Empty kind="all-clear" title="No watcher findings in the live window." />;
  return (
    <div className="feed">
      {items.map((it) => {
        const kind = it.open ? it.sev : "ok";
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
                <span className="ns">{it.ns}</span> · {it.open ? "open" : "closed"}, {it.status}
              </div>
            </div>
            <div className="m">
              first seen
              <br />
              {ago(it.at, now)}
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
