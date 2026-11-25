import { Banner } from "capsomer/react/banner";
import { Group } from "capsomer/react/disclosure";
import { RowList } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import { JobRow } from "./shared";
import { trendChart } from "./charts";
import { Suspense } from "react";
import { Spinner } from "capsomer/react/skeleton";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { LIVE, fetchDigest, fetchPlan } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { DAY, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { useSinceLastVisit } from "capsomer/react/state-hooks";
import type { PortalDigest, PortalPlan } from "../types";
import { Status } from "capsomer/react/status";

const TonightTimeline = trendChart("TonightTimeline");

function Failed({ what, error }: { what: string; error: string | null }) {
  return error ? (
    <Banner tone="crit">
      Could not read {what}: {error}
    </Banner>
  ) : null;
}

const SOURCE: Record<PortalPlan["lanes"][number]["jobs"][number]["estimate_source"], string> = {
  policy: "from the policy",
  record: "from its record",
  default: "default",
};

export function Tonight() {
  const { now } = useApp();
  const load = useAnswer<PortalPlan>([LIVE, "plan"], fetchPlan);
  const plan = load.data;
  const planned = plan ? plan.lanes.reduce((n, l) => n + l.jobs.length, 0) : 0;
  return (
    <Panel
      flush
      title="Tonight"
      id="tonight"
      section="Tonight"
      count={plan ? planned : undefined}
      src={
        plan
          ? `planned ${ago(parse(plan.generated), now)} · ${plan.budget_minutes} min budget`
          : undefined
      }
    >
      <Failed what="the plan" error={load.error} />
      {plan && plan.policy !== "document" && (
        <Banner tone="warn">
          {plan.policy_note ??
            (plan.policy === "default"
              ? "No overnight policy document: every repo counts as heavy."
              : "The overnight policy document did not parse.")}
        </Banner>
      )}
      {!plan && load.loading ? (
        <Spinner layout="page" label="Reading tonight's plan..." />
      ) : plan && (planned || plan.skipped.length) ? (
        <>
          {planned > 0 && (
            <Suspense fallback={null}>
              <TonightTimeline plan={plan} />
            </Suspense>
          )}
          {plan.lanes.map((lane) => (
            <div key={lane.repo} data-lane={lane.repo}>
              <Group
                label={`${lane.repo}, ${lane.planned_minutes} min${lane.heavy ? ", heavy, shares the budget" : ""}`}
                count={lane.jobs.length}
                defaultExpanded
                headingLevel={3}
                body="list"
              >
                <RowList label={lane.repo}>
                  {lane.jobs.map((j) => (
                    <JobRow
                      key={j.id}
                      job={j}
                      status={
                        j.gated ? (
                          <Status tone="warn" glyph="blocked">
                            Gated
                          </Status>
                        ) : (
                          <Status tone="muted" glyph="queued">
                            Planned
                          </Status>
                        )
                      }
                      detail={`about ${j.estimate_minutes} min, ${SOURCE[j.estimate_source]}`}
                      fact={`priority ${j.priority}`}
                    />
                  ))}
                </RowList>
              </Group>
            </div>
          ))}
          {plan.skipped.length > 0 && (
            <div data-group="skipped">
              <Group
                label="Skipped"
                count={plan.skipped.length}
                defaultExpanded
                headingLevel={3}
                body="list"
              >
                <RowList label="Skipped">
                  {plan.skipped.map((j) => (
                    <JobRow
                      key={j.id}
                      job={j}
                      status={<Status tone="nodata">Skipped</Status>}
                      detail={j.reason}
                    />
                  ))}
                </RowList>
              </Group>
            </div>
          )}
          {plan.truncated && (
            <div className="cap-text body" data-tone="dim">
              More are queued than shown.
            </div>
          )}
        </>
      ) : plan ? (
        <Empty kind="all-clear" title="Nothing is queued for tonight." />
      ) : null}
    </Panel>
  );
}

const LAST_LOOKED_PREF = "wf-last-looked";

export function SinceLastLooked() {
  const { now } = useApp();
  // The server renders the last 24 hours; this browser's own last look is read once after hydration, so server and first render agree.
  const since = useSinceLastVisit(LAST_LOOKED_PREF, now, DAY);
  const load = useAnswer<PortalDigest>([LIVE, "digest", since], () => fetchDigest(since));
  const d = load.data;
  const merged = d?.pull_requests_merged ?? 0;
  return (
    <Panel title="Since you last looked" id="since" src={`since ${ago(parse(since), now)}`}>
      <Failed what="the digest" error={load.error} />
      {!d && load.loading ? (
        <Spinner layout="page" label="Reading what happened..." />
      ) : d ? (
        <div>
          <p data-digest="">
            <b className="cap-num">{d.finished.length}</b> finished ·{" "}
            <b className="cap-num">{merged}</b> merged ·{" "}
            <b className="cap-num">{d.pull_requests_ready.length}</b> ready for you ·{" "}
            <b className="cap-num">{d.blocked.length}</b> blocked
          </p>
          {(d.pull_requests_ready.length > 0 || d.blocked.length > 0) && (
            <details>
              <summary>Show them</summary>
              {d.pull_requests_ready.length > 0 && (
                <ul>
                  {d.pull_requests_ready.map((p) => (
                    <li key={p.url}>
                      <a href={p.url} target="_blank" rel="noreferrer noopener">
                        {p.url.replace("https://github.com/", "")}
                      </a>{" "}
                      <span className="cap-text" data-tone="dim">
                        {p.state === "unchecked" ? "not checked yet" : p.state}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {d.blocked.length > 0 && (
                <ul>
                  {d.blocked.map((b) => (
                    <li
                      key={b.id}
                      data-row=""
                      data-open={`job:${b.id}`}
                      role="button"
                      tabIndex={0}
                      className="click"
                    >
                      <b>{b.title}</b>{" "}
                      <span className="cap-text" data-tone="dim">
                        blocked {ago(parse(b.at), now)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {d.truncated.length > 0 && (
            <p className="cap-text hint" data-tone="dim" data-size="small">
              Cut short: {d.truncated.join("; ")}.
            </p>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
