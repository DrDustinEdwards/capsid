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
import { BulkBar, useBulkSelection, type BulkSelection } from "capsomer/react/bulk-bar";
import { Group } from "capsomer/react/disclosure";
import { AwayLink } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, RowReply, type RowLinkProps } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import "capsomer/bulk-bar.css";
import "capsomer/group.css";
import "capsomer/check.css";
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

// One kind's rows: a Capsomer group row in a heading, open, holding a row list. `after`
// sits under the list (the PR group's bulk bar).
function WaitGroup({
  id,
  title,
  count,
  after,
  children,
}: {
  id: string;
  title: string;
  count: number;
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-group={id}>
      <Group label={title} count={count} defaultExpanded headingLevel={3} body="list">
        <RowList label={title}>{children}</RowList>
        {after}
      </Group>
    </div>
  );
}

// A link out of the Portal, opened in a new tab: a row's title when it lives on GitHub.
const newTab = ({ children, ...props }: RowLinkProps) => (
  <a {...props} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

// ---- pull requests

function PrGroup({ entries }: { entries: Entry[] }) {
  const { feed, confirm } = useApp();
  const rows = entries.map((e) => ({ ...e, seat: seatFor(feed, e.item.link) }));
  const approvable = rows.flatMap((r) => (r.seat && canApprove(r.seat) ? [r.seat] : []));
  const batch = approvable.length > 1;
  const ticks = useBulkSelection(approvable.map((a) => ({ id: prAnchor(a) })));
  const chosen = approvable.filter((a) => ticks.has(prAnchor(a)));
  return (
    <WaitGroup
      id="w-prs"
      title="Pull requests"
      count={entries.length}
      after={
        batch && (
          <BulkBar
            label="Approve pull requests together"
            items={chosen.map((a) => ({ id: prAnchor(a), label: prName(a) }))}
            total={approvable.length}
            onSelectAll={ticks.toggleAll}
            onClear={ticks.clear}
            actions={[
              {
                id: "approve",
                label: "Approve selected",
                handOff: () => confirm({ ...approveAllRequest(chosen), onDone: ticks.clear }),
              },
            ]}
          />
        )
      }
    >
      {rows.map(({ app, item, seat }, i) => (
        <PrRow
          key={`${item.link ?? item.title}|${i}`}
          app={app}
          item={item}
          seat={seat}
          ticks={batch ? ticks : null}
        />
      ))}
    </WaitGroup>
  );
}

const prName = (a: OpsAwaitingSeat) => `${a.repo} #${a.number}`;

function PrRow({
  app,
  item,
  seat,
  ticks,
}: {
  app: InboxApp;
  item: InboxItem;
  seat: OpsAwaitingSeat | undefined;
  ticks: BulkSelection | null;
}) {
  const { now, confirm } = useApp();
  const name = seat ? prName(seat) : item.title;
  const ok = seat && canApprove(seat) ? seat : null;
  return (
    <Row
      title={item.title}
      href={item.link ?? undefined}
      renderLink={newTab}
      media={
        ticks ? (
          ok ? (
            <label className="cap-check">
              <input
                type="checkbox"
                checked={ticks.has(prAnchor(ok))}
                onChange={() => ticks.toggle(prAnchor(ok))}
              />
              <span className="cap-sr-only">Select {name}</span>
            </label>
          ) : (
            <span />
          )
        ) : undefined
      }
      detail={`${app.name} · waiting ${age(parse(item.since), now)}${seat?.why ? ` · ${seat.why}` : ""}`}
      actions={
        <>
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
            <span className="cap-text" data-tone="dim" data-size="small">
              {seat.class === "typed"
                ? "Approve it by typing its number in chat."
                : "Not approvable here."}
            </span>
          )}
        </>
      }
    />
  );
}

// ---- questions and blocked jobs

function JobGroup({ entries }: { entries: Entry[] }) {
  return (
    <WaitGroup id="w-jobs" title="Questions and blocked jobs" count={entries.length}>
      {entries.map(({ app, item }, i) => (
        <JobRow key={`${item.job ?? item.title}|${i}`} app={app} item={item} />
      ))}
    </WaitGroup>
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
  const said = j?.waits_on ? (question ? `Asks: ${asks(j)}` : `Waits on: ${j.waits_on}`) : null;
  const from = `${app.name} · waiting ${age(parse(item.since), now)}${j?.claimed_by ? ` · ${agentLabel(j.claimed_by)}` : ""}`;
  return (
    <Row
      status={
        <Status tone="warn" glyph={question ? "question" : "blocked"}>
          {question ? "Question" : "Blocked"}
        </Status>
      }
      // The title opens the job's panel; the job id is there (D11).
      title={item.title}
      onOpen={j ? () => open(`job:${j.id}`) : undefined}
      href={!j && item.link ? item.link : undefined}
      renderLink={newTab}
      detail={said ? `${said} · ${from}` : from}
      actions={
        <>
          {j && item.link && (
            <AwayLink href={item.link} newTab>
              GitHub
            </AwayLink>
          )}
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
            <span className="cap-text" data-tone="dim" data-size="small">{`Now ${j.status}.`}</span>
          )}
        </>
      }
      reply={
        replying ? (
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
        ) : undefined
      }
    />
  );
}

// ---- stopped queues

function StopGroup({ list, onReset }: { list: PortalNamespace[]; onReset: () => void }) {
  const { confirm } = useApp();
  return (
    <WaitGroup id="w-stops" title="Paused after repeated failures" count={list.length}>
      {list.map((n) => (
        <Row
          key={n.namespace}
          status={<Status tone="crit">Paused</Status>}
          title={n.namespace}
          detail={`${n.breaker.failed} jobs failed since ${n.breaker.since} UTC. No job here starts until you reset it.`}
          actions={
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
          }
        />
      ))}
    </WaitGroup>
  );
}

// ---- everything else: it opens where it is fixed

function OtherGroup({ entries }: { entries: Entry[] }) {
  const { now } = useApp();
  return (
    <WaitGroup id="w-other" title="Also waiting" count={entries.length}>
      {entries.map(({ app, item }, i) => {
        const k = KIND[item.kind] ?? {
          label: item.kind,
          tone: "warn" as const,
        };
        return (
          <Row
            key={`${item.kind}|${item.title}|${i}`}
            status={
              <Status tone={k.tone} glyph={k.glyph}>
                {k.label}
              </Status>
            }
            title={item.title}
            href={item.link ?? undefined}
            renderLink={newTab}
            meta={`${app.name} · ${ago(parse(item.since), now)}`}
          />
        );
      })}
    </WaitGroup>
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
      {sites.map((site) => {
        const mine = open.filter((f) => f.namespace === site);
        return (
          <div key={site} data-digest-site={site}>
            <Group
              label={`${site}, open`}
              count={mine.length}
              defaultExpanded
              headingLevel={3}
              body="list"
            >
              <RowList label={`Weekly digest, ${site}`}>
                {mine.map((f) => (
                  <Row
                    key={f.fingerprint}
                    title={f.headline}
                    detail={f.evidence.join(" · ") || undefined}
                    meta={`since ${ago(parse(f.first_seen), now)}`}
                  />
                ))}
              </RowList>
            </Group>
          </div>
        );
      })}
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
