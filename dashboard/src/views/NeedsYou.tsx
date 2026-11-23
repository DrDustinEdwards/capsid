import { Banner } from "capsomer/react/banner";
import { Suspense, lazy, useState, type ReactNode } from "react";
import { useApp } from "../app/ctx";
import { age, agentLabel, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import {
  approveAllRequest,
  approveRequest,
  canApprove,
  closeRequest,
  prAnchor,
  prName,
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
import { useWaiting, type AutoMergeAsks, type Entry } from "../lib/waiting";

// NEEDS YOU, the home page (docs/design/design-portal-evaluation.md section 4, DECIDE 1,
// ruled 2026-10-09; the Portal reorganization of 2026-11-23). It answers "what do I have to
// decide" and lets each decision be made here: everything waiting for you, by kind, each row
// with its own buttons (approve_pr, pr_close, the auto-merge controls, resume_job,
// reset_breaker) through the one confirm dialog. Then the problems, worst first. What
// happened since you last looked, the weekly digest and the charts are on Activity.

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

export function NeedsYou() {
  return (
    <div className="cap-admin-page">
      <PageHead title="Needs you" />
      <Waiting />
      <Problems />
    </div>
  );
}

function Waiting() {
  const { feed } = useApp();
  const { prs, jobs, other, stops, asks, total, error, reread } = useWaiting(feed);
  return (
    <Panel flush title="Waiting for you" id="waiting" count={total}>
      {error && <Banner tone="warn">Stopped queues could not be read: {error}</Banner>}
      {total === 0 ? (
        <Empty kind="all-clear" title="Nothing needs you." />
      ) : (
        <>
          {prs.length > 0 && <PrGroup entries={prs} />}
          {asks.count > 0 && <AutoMergeGroup asks={asks} />}
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
      id={seat ? prAnchor(seat) : undefined}
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
      detail={
        <>
          {`${app.name} · waiting ${age(parse(item.since), now)}${seat?.why ? ` · ${seat.why}` : ""}`}
          {seat?.visual && <VisualLook visual={seat.visual} />}
        </>
      }
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
          {seat && !ok && seat.class === "typed" && (
            <span className="cap-text" data-tone="dim" data-size="small">
              Approve in chat
            </span>
          )}
        </>
      }
    />
  );
}

// What a visual pull request shows before you approve it (src/visual-pr.ts): its live
// preview and its screenshots, read from the pull request. They open in a new tab as links,
// since the Portal's CSP loads no image from another origin.
function VisualLook({ visual }: { visual: NonNullable<OpsAwaitingSeat["visual"]> }) {
  return (
    <span className="visual-look">
      <span>{visual.title}</span>
      {visual.preview && (
        <AwayLink href={visual.preview} newTab>
          Open the preview
        </AwayLink>
      )}
      {visual.shots.map((src, i) => (
        <AwayLink key={src} href={src} newTab>
          Screenshot {i + 1}
        </AwayLink>
      ))}
      {!visual.preview && !visual.shots.length && (
        <span className="cap-text" data-tone="dim">
          No preview.
        </span>
      )}
    </span>
  );
}

// ---- auto-merge: a policy that does not load, a paused project, a merge unit to sign or lift

// The rows load after first paint, keeping their code off the first screen.
const AutoMergeRows = lazy(() => import("./automerge").then((m) => ({ default: m.AutoMergeRows })));

function AutoMergeGroup({ asks }: { asks: AutoMergeAsks }) {
  return (
    <WaitGroup id="w-automerge" title="Auto-merge" count={asks.count}>
      <Suspense fallback={null}>
        <AutoMergeRows asks={asks} />
      </Suspense>
    </WaitGroup>
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
