import { Suspense } from "react";
import { useApp } from "../app/ctx";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Status, type GlyphName, type Tone } from "capsomer/react/status";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, type RowLinkProps } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import { Link, rowLink } from "../lib/router";
import { useBoard, usePrs } from "../lib/trends";
import { useWaiting } from "../lib/waiting";
import type { PortalBoard, PortalPrs } from "../types";
import { ChartSlot } from "../ui/ChartSlot";
import { boardChart } from "./charts";
import { memoryDocHref } from "./memory-links";
import { Problems } from "./Problems";
import { PageHead } from "./shared";

const HandoffsRing = boardChart("HandoffsRing");
const HandoffsTable = boardChart("HandoffsTable");
const ThreadsChart = boardChart("ThreadsChart");
const RecentThreads = boardChart("RecentThreads");

const KIND: Record<string, { label: string; tone: Tone; glyph?: GlyphName } | undefined> = {
  report: { label: "Reported", tone: "warn", glyph: "report" },
  ci: { label: "CI failing", tone: "crit", glyph: "crit" },
  "site-down": { label: "Site down", tone: "crit", glyph: "site-down" },
};

export function Board() {
  const board = useBoard();
  return (
    <div className="cap-admin-page">
      <PageHead title="Board" />
      <Waiting board={board.data} />
      <Problems />
      <PrTrouble />
      <Handoffs board={board.data} error={board.error} loading={board.loading} />
      <Threads board={board.data} />
    </div>
  );
}

const newTab = ({ children, ...props }: RowLinkProps) => (
  <a {...props} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "").trim())
    .find(Boolean);
  return line ?? text.trim();
}

function Waiting({ board }: { board: PortalBoard | null }) {
  const { feed, now } = useApp();
  const { listed } = useWaiting(feed);
  const asks = board?.waiting_on_dustin ?? [];
  const total = listed.length + asks.length;
  return (
    <Panel flush title="Waiting on you" id="waiting" count={total}>
      {total === 0 ? (
        <Empty kind="all-clear" title="Nothing waits on you." />
      ) : (
        <RowList label="Waiting on you">
          {asks.map((a) => (
            <Row
              key={`${a.namespace}/${a.path}`}
              status={<Status tone="warn">Handoff</Status>}
              title={firstLine(a.text)}
              href={memoryDocHref(a.namespace, a.path)}
              renderLink={rowLink}
              detail={`${a.namespace} · ${a.title || a.path}`}
            />
          ))}
          {listed.map(({ app, item }, i) => {
            const k = KIND[item.kind] ?? { label: item.kind, tone: "warn" as const };
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
                detail={`${app.name} · ${ago(parse(item.since), now)}`}
              />
            );
          })}
        </RowList>
      )}
    </Panel>
  );
}

function troubleOf(data: PortalPrs) {
  const rows: Array<{
    key: string;
    tone: Tone;
    label: string;
    title: string;
    url: string;
    meta: string;
  }> = [];
  const byKey = new Map(data.prs.map((p) => [`${p.repo}#${p.number}`, p]));
  for (const p of data.prs) {
    const where = `${p.repo.split("/")[1]}#${p.number}`;
    if (p.ci === "failure")
      rows.push({
        key: `red|${where}`,
        tone: "crit",
        label: "CI red",
        title: p.title,
        url: p.url,
        meta: where,
      });
    if (p.conflict)
      rows.push({
        key: `conflict|${where}`,
        tone: "warn",
        label: "Conflict",
        title: p.title,
        url: p.url,
        meta: where,
      });
  }
  for (const o of data.overlaps) {
    const a = byKey.get(`${o.repo}#${o.pr}`);
    rows.push({
      key: `overlap|${o.repo}#${o.pr}|${o.other}`,
      tone: "warn",
      label: "Same files",
      title: `#${o.pr} and #${o.other} both change ${o.files.length === 1 ? o.files[0] : `${o.files.length} files`}`,
      url: a?.url ?? `https://github.com/${o.repo}/pull/${o.pr}`,
      meta: o.repo.split("/")[1]!,
    });
  }
  return rows;
}

function PrTrouble() {
  const { now } = useApp();
  const prs = usePrs();
  const data = prs.data;
  const rows = data ? troubleOf(data) : [];
  return (
    <Panel
      flush
      title="Pull request trouble"
      id="pr-trouble"
      count={data ? rows.length : undefined}
      src={
        <>
          {data && `as of ${ago(parse(data.as_of), now)} · `}
          <Link href="/prs">All pull requests</Link>
        </>
      }
    >
      {!data ? (
        <p className="cap-text body" data-tone="dim">
          {prs.error
            ? `Could not read the pull requests: ${prs.error}`
            : "Reading pull requests..."}
        </p>
      ) : rows.length === 0 ? (
        <Empty kind="all-clear" title="No red CI, conflict or shared files." />
      ) : (
        <RowList label="Pull request trouble">
          {rows.map((r) => (
            <Row
              key={r.key}
              status={<Status tone={r.tone}>{r.label}</Status>}
              title={r.title}
              href={r.url}
              renderLink={newTab}
              meta={r.meta}
            />
          ))}
        </RowList>
      )}
      {data && data.not_checked.length > 0 && (
        <p className="cap-text body" data-tone="dim">
          Not checked: {data.not_checked.join("; ")}.
        </p>
      )}
    </Panel>
  );
}

function Handoffs({
  board,
  error,
  loading,
}: {
  board: PortalBoard | null;
  error: string | null;
  loading: boolean;
}) {
  return (
    <Panel
      flush
      title="Open handoffs"
      id="handoffs"
      count={board?.handoffs.open}
      src={
        board && (
          <Suspense fallback={null}>
            <HandoffsRing board={board} />
          </Suspense>
        )
      }
    >
      <div className="body cap-stack" data-gap="4">
        {!board ? (
          <p className="cap-text" data-tone="dim">
            {error ? `Could not read the board: ${error}` : loading ? "Reading the board..." : null}
          </p>
        ) : board.handoffs.open === 0 ? (
          <p className="cap-text">No open handoff.</p>
        ) : (
          <ChartSlot>
            <HandoffsTable board={board} />
          </ChartSlot>
        )}
        {board && board.not_checked.length > 0 && (
          <p className="cap-text" data-tone="dim">
            Not read: {board.not_checked.join("; ")}.
          </p>
        )}
      </div>
    </Panel>
  );
}

function Threads({ board }: { board: PortalBoard | null }) {
  if (!board) return null;
  const t = board.threads;
  return (
    <Panel flush title="Threads" id="threads" count={t.total}>
      <div className="body cap-stack" data-gap="4">
        {t.total === 0 && t.recent.length === 0 ? (
          <p className="cap-text">No thread in {t.days} days.</p>
        ) : (
          <ChartSlot>
            <ThreadsChart threads={t} />
            <RecentThreads threads={t} />
          </ChartSlot>
        )}
      </div>
    </Panel>
  );
}
