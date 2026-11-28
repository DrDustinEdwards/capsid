import { Banner } from "capsomer/react/banner";
import { useState, type ReactNode } from "react";
import { useApp } from "../app/ctx";
import { age, agentLabel, ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { InboxApp, InboxItem, OpsJob, PortalNamespace } from "../types";
import { Status, type GlyphName, type Tone } from "capsomer/react/status";
import { Empty } from "capsomer/react/empty";
import { Group } from "capsomer/react/disclosure";
import { AwayLink } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, RowReply, type RowLinkProps } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import "capsomer/group.css";
import { PageHead } from "./shared";
import { Problems } from "./Problems";
import { useWaiting, type Entry } from "../lib/waiting";

const KIND: Record<string, { label: string; tone: Tone; glyph?: GlyphName } | undefined> = {
  "blocked-job": { label: "Blocked job", tone: "warn", glyph: "blocked" },
  question: { label: "Question", tone: "warn", glyph: "question" },
  report: { label: "Reported", tone: "warn", glyph: "report" },
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
  const { listed, stops, total, error: failed, reread } = useWaiting(feed);
  const jobs = listed.filter((e) => e.item.kind === "question" || e.item.kind === "blocked-job");
  const other = listed.filter((e) => !jobs.includes(e));
  return (
    <Panel flush title="Waiting for you" id="waiting" count={total}>
      {failed && <Banner tone="warn">Some of what waits on you could not be read: {failed}</Banner>}
      {total === 0 ? (
        !failed && <Empty kind="all-clear" title="Nothing needs you." />
      ) : (
        <>
          {jobs.length > 0 && <JobGroup entries={jobs} />}
          {stops.length > 0 && <StopGroup list={stops} onReset={reread} />}
          {other.length > 0 && <OtherGroup entries={other} />}
        </>
      )}
    </Panel>
  );
}

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

const newTab = ({ children, ...props }: RowLinkProps) => (
  <a {...props} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

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
