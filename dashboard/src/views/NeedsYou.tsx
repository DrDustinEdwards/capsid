import { Banner } from "capsomer/react/banner";
import { trendChart } from "./charts";
import { ChartSlot } from "../ui/ChartSlot";
import { Suspense, lazy, useState, type ReactNode } from "react";
import { useApp } from "../app/ctx";
import { LIVE, fetchNamespaces } from "../lib/api";
import { useAnswer } from "capsomer/react/data";
import { hasSites } from "../lib/derive";
import { age, agentLabel, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import {
  approveAllRequest,
  approveRequest,
  canApprove,
  closeRequest,
  prAnchor,
  seatFor,
} from "../lib/pr-actions";
import type { InboxApp, InboxItem, OpsAwaitingSeat, OpsJob, PortalNamespace } from "../types";
import { Status, type GlyphName, type Tone } from "capsomer/react/status";
import { Empty } from "capsomer/react/empty";
import { indeterminate, useSelection, type Selection } from "capsomer/react/state-hooks";
import { Panel } from "capsomer/react/panel";
import { RowReply } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import { PageHead } from "./shared";
import { Problems } from "./Problems";

// NEEDS YOU, the home page (docs/design/design-portal-evaluation.md section 4, DECIDE 1,
// ruled 2026-10-09; the UX audit of 2026-10-19, B1, B3 and M3). It answers "what do I have to
// decide" and lets each decision be made here: first everything waiting for you, by kind,
// each row with its own buttons, the existing controls (approve_pr, pr_close, resume_job,
// reset_breaker) through the one confirm
// dialog. Then the problems, worst first, what happened since you last looked, and the
// charts last, folded away.

// The inbox's kinds that are not decided on this page by their own control: they open
// where they are fixed. Keyed by string, so an unknown kind still shows under its own name and
// its tone's mark. Each kind has its own mark (Dustin's review of 2026-10-11: every row had the
// same pause icon); the color says who acts: warning for a person, critical for a machine fault.
const KIND: Record<string, { label: string; tone: Tone; glyph?: GlyphName } | undefined> = {
  "blocked-job": { label: "Blocked job", tone: "warn", glyph: "blocked" },
  question: { label: "Question", tone: "warn", glyph: "question" },
  pr: { label: "Pull request", tone: "warn", glyph: "pr" },
  report: { label: "Reported", tone: "warn", glyph: "report" },
  proposal: { label: "Proposal", tone: "warn", glyph: "proposal" },
  ci: { label: "CI failing", tone: "crit", glyph: "crit" },
  "site-down": { label: "Site down", tone: "crit", glyph: "site-down" },
};

// The digest strip loads after first paint, so the home's first screen is not held up by
// its read.
const SinceLastLooked = lazy(() =>
  import("./Overnight").then((m) => ({ default: m.SinceLastLooked })),
);
// The two charts load only when Trends is opened: their Enarratio code and their reads stay
// off the first screen.
const MinutesTile = trendChart("MinutesTile");
const WaitingChart = trendChart("WaitingChart");

export function NeedsYou() {
  const { feed } = useApp();
  return (
    <div className="cap-admin-page">
      <PageHead title="Needs you" />
      <Waiting />
      <Problems sitesOn={hasSites(feed)} />
      <Suspense fallback={null}>
        <SinceLastLooked />
      </Suspense>
      <WeeklyDigest />
      <Trends />
    </div>
  );
}

// ---- Waiting for you -----------------------------------------------------------------------

type Entry = { app: InboxApp; item: InboxItem };

// Queues stopped by the circuit breaker (src/job-breaker.ts), from the roster read
// (GET /portal/api/namespaces), read again with each feed so a reset drops its row.
function useStops(): {
  stops: PortalNamespace[];
  error: string | null;
  reread: () => void;
} {
  const load = useAnswer([LIVE, "namespaces"], fetchNamespaces);
  return {
    stops: load.data?.namespaces.filter((n) => n.breaker.open) ?? [],
    error: load.error,
    reread: load.reread,
  };
}

function Waiting() {
  const { feed, now } = useApp();
  const inbox = feed.live.inbox;
  const { stops, error, reread } = useStops();
  const all: Entry[] = inbox.apps.flatMap((app) => app.items.map((item) => ({ app, item })));
  const prs = all.filter((e) => e.item.kind === "pr");
  const jobs = all.filter((e) => e.item.kind === "question" || e.item.kind === "blocked-job");
  const other = all.filter((e) => !prs.includes(e) && !jobs.includes(e));
  const total = all.length + stops.length;
  const quiet = inbox.apps.filter((a) => a.count === 0);
  return (
    <Panel
      flush
      title="Waiting for you"
      id="waiting"
      count={total}
      src={`read ${ago(parse(inbox.generated), now)}`}
      footer={
        quiet.length > 0 ? (
          <span className="cap-text" data-tone="dim">
            Nothing waiting: {quiet.map((a) => a.name).join(", ")}
          </span>
        ) : undefined
      }
    >
      {error && <Banner tone="warn">Stopped queues could not be read: {error}</Banner>}
      {total === 0 ? (
        <Empty kind="all-clear" title="Nothing needs you." />
      ) : (
        <>
          {prs.length > 0 && <PrGroup entries={prs} />}
          {jobs.length > 0 && <JobGroup entries={jobs} />}
          {stops.length > 0 && <StopGroup list={stops} onReset={reread} />}
          {other.length > 0 && <OtherGroup entries={other} />}
        </>
      )}
    </Panel>
  );
}

// One kind's rows under its heading. With batch, the heading carries a "select all" box and,
// once a row is ticked, the button that decides the ticked rows together.
function Group({
  id,
  title,
  count,
  batch,
  children,
}: {
  id: string;
  title: string;
  count: number;
  batch?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="wgroup" aria-labelledby={`${id}-h`} data-group={id}>
      <div className="wgroup-head">
        <h3 id={`${id}-h`}>
          {title}{" "}
          <span className="cap-text cap-num" data-tone="dim">
            {count}
          </span>
        </h3>
        {batch}
      </div>
      <ul className="wlist">{children}</ul>
    </section>
  );
}

function SelectAll({ label, ticks }: { label: string; ticks: Selection }) {
  return (
    <label className="wselect">
      <input
        type="checkbox"
        checked={ticks.all}
        ref={indeterminate(ticks.some)}
        onChange={(e) => ticks.setAll(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Tick({ label, on, flip }: { label: string; on: boolean; flip: () => void }) {
  return (
    <label className="wtick">
      <input type="checkbox" checked={on} onChange={flip} />
      <span className="cap-sr-only">{label}</span>
    </label>
  );
}

// Where the row came from and how long it has waited, in one quiet line.
function Meta({ children }: { children: ReactNode }) {
  return <div className="wmeta">{children}</div>;
}

function GitHub({ href }: { href: string }) {
  return (
    <a className="wlink" href={href} target="_blank" rel="noreferrer noopener">
      Open on GitHub
    </a>
  );
}

// ---- pull requests

function PrGroup({ entries }: { entries: Entry[] }) {
  const { feed, confirm } = useApp();
  const rows = entries.map((e) => ({ ...e, seat: seatFor(feed, e.item.link) }));
  const approvable = rows.flatMap((r) => (r.seat && canApprove(r.seat) ? [r.seat] : []));
  const keys = approvable.map(prAnchor);
  const ticks = useSelection(keys);
  const chosen = approvable.filter((a) => ticks.has(prAnchor(a)));
  return (
    <Group
      id="w-prs"
      title="Pull requests"
      count={entries.length}
      batch={
        approvable.length > 1 && (
          <div className="wbatch">
            <SelectAll label="Select all" ticks={ticks} />
            {chosen.length > 0 && (
              <button
                type="button"
                className="cap-btn"
                data-variant="primary"
                onClick={() =>
                  confirm({ ...approveAllRequest(chosen), onDone: () => ticks.setAll(false) })
                }
              >
                Approve {chosen.length} selected
              </button>
            )}
          </div>
        )
      }
    >
      {rows.map(({ app, item, seat }, i) => (
        <PrRow
          key={`${item.link ?? item.title}|${i}`}
          app={app}
          item={item}
          seat={seat}
          ticks={approvable.length > 1 ? ticks : null}
        />
      ))}
    </Group>
  );
}

function PrRow({
  app,
  item,
  seat,
  ticks,
}: {
  app: InboxApp;
  item: InboxItem;
  seat: OpsAwaitingSeat | undefined;
  ticks: Selection | null;
}) {
  const { now, confirm } = useApp();
  const name = seat ? `${seat.repo} #${seat.number}` : item.title;
  const ok = seat && canApprove(seat) ? seat : null;
  return (
    <li className="wrow" data-row="" data-kind="pr" id={seat ? `w-${prAnchor(seat)}` : undefined}>
      {ticks && ok ? (
        <Tick
          label={`Select ${name}`}
          on={ticks.has(prAnchor(ok))}
          flip={() => ticks.toggle(prAnchor(ok))}
        />
      ) : ticks ? (
        <span className="wtick" />
      ) : null}
      <div className="wmain">
        <b>{item.title}</b>
        <Meta>
          {app.name} · waiting {age(parse(item.since), now)}
          {seat?.why ? ` · ${seat.why}` : ""}
        </Meta>
        {item.link && <GitHub href={item.link} />}
      </div>
      <div className="wact">
        {ok && (
          <button
            type="button"
            className="cap-btn"
            data-variant="primary"
            aria-label={`Approve ${name}`}
            onClick={() => confirm(approveRequest(ok))}
          >
            Approve
          </button>
        )}
        {seat && (
          <button
            type="button"
            className="cap-btn"
            aria-label={`Close ${name}`}
            onClick={() => confirm(closeRequest(seat))}
          >
            Close
          </button>
        )}
        {seat && !ok && (
          <span className="cap-text wnote" data-tone="dim">
            {seat.class === "typed"
              ? "Approve it by typing its number in chat."
              : "Not approvable here."}
          </span>
        )}
      </div>
    </li>
  );
}

// ---- questions and blocked jobs

function JobGroup({ entries }: { entries: Entry[] }) {
  return (
    <Group id="w-jobs" title="Questions and blocked jobs" count={entries.length}>
      {entries.map(({ app, item }, i) => (
        <JobRow key={`${item.job ?? item.title}|${i}`} app={app} item={item} />
      ))}
    </Group>
  );
}

const asks = (j: OpsJob | undefined) => (j?.waits_on ?? "").replace(/^QUESTION:\s*/, "");

function JobRow({ app, item }: { app: InboxApp; item: InboxItem }) {
  const { feed, now, open, confirm } = useApp();
  const j = item.job ? feed.live.jobs.find((x) => x.id === item.job) : undefined;
  const question = j ? j.question === true : item.kind === "question";
  const verb = question ? "Answer" : "Resume";
  const [replying, setReplying] = useState(false);
  const blocked = j?.status === "blocked";
  const send = (text: string) => {
    if (!j) return;
    confirm({
      action: "resume_job",
      params: { id: j.id, reason: text },
      title: `${question ? "Answer" : "Resume job"}: ${j.title}`,
      onDone: () => setReplying(false),
    });
  };
  return (
    <li
      className="wrow"
      data-row=""
      data-kind={question ? "question" : "blocked-job"}
      data-job={item.job}
    >
      <div className="wmain">
        <Status tone="warn" glyph={question ? "question" : "blocked"}>
          {question ? "Question" : "Blocked"}
        </Status>
        <b>{item.title}</b>
        {j?.waits_on && (
          <p className="wask">{question ? `Asks: ${asks(j)}` : `Waits on: ${j.waits_on}`}</p>
        )}
        <Meta>
          {app.name} · waiting {age(parse(item.since), now)}
          {j?.claimed_by ? ` · ${agentLabel(j.claimed_by)}` : ""}
        </Meta>
        <span className="wlinks">
          {j && (
            <button
              type="button"
              className="cap-link-btn wlink"
              onClick={() => open(`job:${j.id}`)}
            >
              More about this job
            </button>
          )}
          {item.link && <GitHub href={item.link} />}
        </span>
        {replying && (
          <RowReply
            label={
              question
                ? "Your answer, sent to its driver"
                : "What you did or approved, sent to its driver"
            }
            emptyHint={question ? "Type your answer first." : "Say what you did or approved first."}
            onSend={send}
            onCancel={() => setReplying(false)}
          />
        )}
      </div>
      <div className="wact">
        {blocked && !replying && (
          <button
            type="button"
            className="cap-btn"
            data-variant="primary"
            aria-label={`${verb} ${item.title}`}
            onClick={() => setReplying(true)}
          >
            {verb}
          </button>
        )}
        {!blocked && j && (
          <span className="cap-text wnote" data-tone="dim">{`Now ${j.status}.`}</span>
        )}
      </div>
    </li>
  );
}

// ---- stopped queues

function StopGroup({ list, onReset }: { list: PortalNamespace[]; onReset: () => void }) {
  const { confirm } = useApp();
  return (
    <Group id="w-stops" title="Paused after repeated failures" count={list.length}>
      {list.map((n) => (
        <li className="wrow" data-row="" key={n.namespace} data-stop={n.namespace}>
          <div className="wmain">
            <Status tone="crit">Paused</Status>
            <b>{n.namespace}</b>
            <Meta>
              {n.breaker.failed} jobs failed since {n.breaker.since} UTC. No job here starts until
              you reset it.
            </Meta>
          </div>
          <div className="wact">
            <button
              type="button"
              className="cap-btn"
              data-variant="primary"
              aria-label={`Reset ${n.namespace}`}
              onClick={() =>
                confirm({
                  action: "reset_breaker",
                  params: { namespace: n.namespace },
                  title: `Restart the queue for ${n.namespace}`,
                  onDone: onReset,
                })
              }
            >
              Reset
            </button>
          </div>
        </li>
      ))}
    </Group>
  );
}

// ---- everything else: it opens where it is fixed

function OtherGroup({ entries }: { entries: Entry[] }) {
  const { now } = useApp();
  return (
    <Group id="w-other" title="Also waiting" count={entries.length}>
      {entries.map(({ app, item }, i) => {
        const k = KIND[item.kind] ?? {
          label: item.kind,
          tone: "warn" as const,
        };
        return (
          <li className="wrow" key={`${item.kind}|${item.title}|${i}`} data-kind={item.kind}>
            <div className="wmain">
              <Status tone={k.tone} glyph={k.glyph}>
                {k.label}
              </Status>
              {item.link ? (
                <a className="wtitle" href={item.link} target="_blank" rel="noreferrer noopener">
                  {item.title}
                </a>
              ) : (
                <b>{item.title}</b>
              )}
              <Meta>
                {app.name} · {ago(parse(item.since), now)}
              </Meta>
            </div>
          </li>
        );
      })}
    </Group>
  );
}

// ---- Weekly digest ----------------------------------------------------------------------

// The watcher's digest-class findings (src/watcher.ts, findingClass): CSP, security
// headers, analytics and beacon settings, scorer drift. They post no job; one block per
// site lists what is open, and the Monday email carries the same list. Hidden while none
// is open, so a quiet week adds nothing to the page.
function WeeklyDigest() {
  const { feed, now } = useApp();
  const open = feed.live.findings.filter((f) => f.class === "digest");
  if (open.length === 0) return null;
  const sites = [...new Set(open.map((f) => f.namespace))].sort();
  return (
    <Panel
      title="Weekly digest"
      id="weekly-digest"
      section="Weekly digest"
      count={open.length}
      src="watcher findings that post no job"
    >
      {sites.map((site) => (
        <section
          className="wgroup"
          key={site}
          aria-label={`Weekly digest, ${site}`}
          data-digest-site={site}
        >
          <div className="wgroup-head">
            <h3>
              {site}
              <span className="cap-text cap-num" data-tone="dim">
                {" "}
                {open.filter((f) => f.namespace === site).length} open
              </span>
            </h3>
          </div>
          <ul className="wlist">
            {open
              .filter((f) => f.namespace === site)
              .map((f) => (
                <li className="wrow" key={f.fingerprint} title={f.evidence.join("\n")}>
                  <span className="wmain">
                    <b>{f.headline}</b>
                    <span className="wmeta">since {ago(parse(f.first_seen), now)}</span>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </Panel>
  );
}

// ---- Trends ---------------------------------------------------------------------------

// The two charts, folded away at the foot (UX audit B3): the list comes first and never
// moves. They are drawn on the server inside the fold, so opening it shows them at once, with
// scripts or without.
function Trends() {
  return (
    <details className="trends" id="trends">
      <summary>
        <span className="chev" aria-hidden="true" />
        Trends{" "}
        <span className="cap-text" data-tone="dim" data-size="small">
          your time per week, and where waiting goes
        </span>
      </summary>
      <div className="trends-body chart-row">
        <ChartSlot>
          <MinutesTile />
        </ChartSlot>
        <ChartSlot>
          <WaitingChart />
        </ChartSlot>
      </div>
    </details>
  );
}
