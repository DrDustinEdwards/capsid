import { useApp } from "../app/ctx";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Status, type GlyphName, type Tone } from "capsomer/react/status";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList, type RowLinkProps } from "capsomer/react/row-list";
import "capsomer/row-list.css";
import { PageHead } from "./shared";
import { Problems } from "./Problems";
import { useWaiting, type Entry } from "../lib/waiting";

const KIND: Record<string, { label: string; tone: Tone; glyph?: GlyphName } | undefined> = {
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
  const { listed, total } = useWaiting(feed);
  return (
    <Panel flush title="Waiting for you" id="waiting" count={total}>
      {total === 0 ? (
        <Empty kind="all-clear" title="Nothing needs you." />
      ) : (
        <WaitingRows entries={listed} />
      )}
    </Panel>
  );
}

const newTab = ({ children, ...props }: RowLinkProps) => (
  <a {...props} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

function WaitingRows({ entries }: { entries: Entry[] }) {
  const { now } = useApp();
  return (
    <RowList label="Waiting for you">
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
    </RowList>
  );
}
