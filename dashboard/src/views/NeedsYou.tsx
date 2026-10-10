import { useState } from "react";
import { Link } from "wouter";
import { isView, routePath, useApp, type ViewId } from "../app/ctx";
import { PROBLEM_ROWS, attentionGroups, hasSites, type AttentionRow, type Kind } from "../lib/derive";
import { ago, ms } from "../lib/format";
import type { InboxApp, InboxItem } from "../types";
import { Anchors } from "../ui/anchors";
import { St } from "../ui/icons";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

// NEEDS YOU, the home page (docs/design/design-portal-evaluation.md section 4, DECIDE 1,
// ruled 2026-10-09; job_d62abdbfc270 PR 1). It answers "what do I have to decide": first
// what needs Dustin per app, from the same gatherer GET /ops/inbox answers with
// (src/inbox.ts), then the problems the Overview used to list, worst first. The Overview
// keeps the glance at the system.

// The inbox's kinds, as a word and a status. Waiting on a person is a warning-toned word
// (the queue's "blocked"); a machine fault is critical. Keyed by string, not InboxKind, so
// "report" (an app's own report, capsid #321) reads the same whichever lands first; an
// unknown kind still shows, under its own name.
const KIND: Record<string, { label: string; kind: Kind } | undefined> = {
  "blocked-job": { label: "Blocked job", kind: "blocked" },
  question: { label: "Question", kind: "blocked" },
  pr: { label: "Pull request", kind: "blocked" },
  report: { label: "Reported", kind: "blocked" },
  ci: { label: "CI failing", kind: "crit" },
  "site-down": { label: "Site down", kind: "crit" },
};

export function NeedsYou() {
  const { feed } = useApp();
  return (
    <div className="page">
      <Anchors />
      <PageHead title="Needs you" />
      <ByApp />
      <NeedsAttention sitesOn={hasSites(feed)} />
    </div>
  );
}

// ---- By app ----------------------------------------------------------------------------

// One block per app with something waiting, worst first, then one line naming the quiet
// ones, so the admin strip's badges and this page always agree.
function ByApp() {
  const { feed, now } = useApp();
  const inbox = feed.live.inbox;
  const rank = { "needs-you": 0, failing: 1, none: 2 } as const;
  const busy = inbox.apps.filter((a) => a.count > 0).sort((x, y) => rank[x.severity] - rank[y.severity] || y.count - x.count);
  const quiet = inbox.apps.filter((a) => a.count === 0);
  return (
    <Panel
      title="By app"
      id="by-app"
      section="By app"
      count={inbox.count}
      src={`inbox read ${ago(ms(inbox.generated), now)}`}
      footer={quiet.length > 0 ? <span className="faint">Nothing waiting: {quiet.map((a) => a.name).join(", ")}</span> : undefined}
    >
      {busy.length ? (
        <div className="inbox-apps">
          {busy.map((app) => (
            <AppBlock key={app.namespace} app={app} />
          ))}
        </div>
      ) : (
        <Empty kind="all-clear" title="Nothing needs you." />
      )}
    </Panel>
  );
}

function AppBlock({ app }: { app: InboxApp }) {
  const headingId = `inbox-${app.namespace.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <section className="inbox-app" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {app.name}
        <span className="num faint">
          {" "}
          {app.count} {app.severity === "needs-you" ? "need you" : "failing"}
        </span>
      </h3>
      <ul className="inbox-items">
        {app.items.map((item, i) => (
          <InboxRow key={`${item.kind}|${item.title}|${i}`} item={item} />
        ))}
      </ul>
    </section>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const { now } = useApp();
  const k = KIND[item.kind] ?? { label: item.kind, kind: "blocked" as const };
  return (
    <li className="inbox-item">
      <span className="kind">
        <St kind={k.kind}>{k.label}</St>
      </span>
      <span className="what">
        {item.link ? (
          <a href={item.link} target="_blank" rel="noreferrer noopener">
            {item.title}
          </a>
        ) : (
          <b>{item.title}</b>
        )}
      </span>
      <span className="when">{ago(ms(item.since), now)}</span>
    </li>
  );
}

// ---- Needs attention (moved from the Overview) ----------------------------------------------------------------

function NeedsAttention({ sitesOn }: { sitesOn: boolean }) {
  const { feed, now } = useApp();
  const { problems, notices, noticeCount } = attentionGroups(feed, now);
  const [more, setMore] = useState(false);
  // Every critical row is shown; warnings fill the rest of the first PROBLEM_ROWS.
  const crit = problems.filter((p) => p.sev === "crit");
  const room = Math.max(0, PROBLEM_ROWS - crit.length);
  const warn = problems.filter((p) => p.sev !== "crit");
  const hidden = warn.length > room ? warn.slice(room) : [];
  const shown = [...crit, ...(hidden.length ? warn.slice(0, room) : warn)];
  return (
    <section className="attention" id="attention" data-section="Needs attention" aria-labelledby="attH">
      <header>
        <h2 id="attH">Needs attention</h2>
        <span className="num faint">{problems.length ? `${problems.length} ${problems.length === 1 ? "problem" : "problems"}, worst first` : "no problems"}</span>
        <span className="src ml-auto">{sitesOn ? "sites, " : ""}backups, CI, queue, watcher, agents</span>
      </header>
      {problems.length ? (
        <div className="att-list">
          {shown.map((a) => (a.children ? <GroupRow key={a.key} row={a} /> : <ProblemRow key={a.key} row={a} />))}
          {hidden.length > 0 && (
            <>
              <div className="att-more">
                <button type="button" className="linkbtn" aria-expanded={more} aria-controls="att-more" onClick={() => setMore(!more)}>
                  {more ? "Fewer warnings" : `${hidden.length} more ${hidden.length === 1 ? "warning" : "warnings"}`}
                </button>
              </div>
              <div id="att-more" hidden={!more}>
                {more && hidden.map((a) => (a.children ? <GroupRow key={a.key} row={a} /> : <ProblemRow key={a.key} row={a} />))}
              </div>
            </>
          )}
        </div>
      ) : (
        <Empty kind="all-clear" title="All clear. Nothing needs you." />
      )}
      {notices.length > 0 && <Notices rows={notices} count={noticeCount} />}
    </section>
  );
}

function ProblemRow({ row }: { row: AttentionRow }) {
  const { now } = useApp();
  return (
    <div className={row.sev === "crit" ? "att-row sev-crit" : "att-row"} data-row="" data-open={row.open} tabIndex={0}>
      <span className="kind">
        <St kind={row.sev}>{row.kind}</St>
      </span>
      <div className="what">
        <b>{row.title}</b>
        <div>{row.sub}</div>
      </div>
      <span className="when">{ago(row.at, now)}</span>
    </div>
  );
}

// A group opens in place (APG Disclosure): up to five children, each opening its panel
// or view, then a link to the view that lists them all.
function GroupRow({ row }: { row: AttentionRow }) {
  const { now } = useApp();
  const [open, setOpen] = useState(false);
  const id = `att-${row.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const kids = row.children ?? [];
  const view = row.view && isView(row.view.id) ? row.view : null;
  return (
    <>
      <div className={row.sev === "crit" ? "att-row grp sev-crit" : "att-row grp"}>
        <span className="kind">
          <St kind={row.sev}>{row.kind}</St>
        </span>
        <div className="what">
          <button type="button" className="rowlink" data-row="" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            {row.title}
          </button>
          <div>{row.sub}</div>
        </div>
        <span className="when">
          {ago(row.at, now)} <span className="chev" aria-hidden="true" />
        </span>
      </div>
      <div className="att-kids" id={id} hidden={!open}>
        {open && (
          <>
            {kids.map((k) => (
              <div className="att-child" key={`${k.open}|${k.title}`} data-row="" data-open={k.open} tabIndex={0}>
                <div className="what">
                  <b>{k.title}</b>
                  <div>{k.sub}</div>
                </div>
                <span className="when">{ago(k.at, now)}</span>
              </div>
            ))}
            {view && (
              <div className="grouplink">
                <Link href={routePath(view.id as ViewId)}>{(row.total ?? 0) > kids.length ? `All ${row.total} in ${view.label}` : `Open ${view.label}`}</Link>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// One row at the foot of the list, closed: facts with nothing to do now. A group of
// notices (silent drivers) is one line that opens its view, not a second disclosure.
function Notices({ rows, count }: { rows: AttentionRow[]; count: number }) {
  const { now } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div className="notices">
      <div className="att-row grp notice-head">
        <span className="kind">
          <St kind="nodata">Notices</St>
        </span>
        <div className="what">
          <button type="button" className="rowlink" data-row="" aria-expanded={open} aria-controls="att-notices" onClick={() => setOpen(!open)}>
            {count} {count === 1 ? "notice" : "notices"}
          </button>
          <div>Missing data and quiet agents: nothing to act on now</div>
        </div>
        <span className="when">
          <span className="chev" aria-hidden="true" />
        </span>
      </div>
      <div className="att-kids" id="att-notices" hidden={!open}>
        {open &&
          rows.map((r) => (
            <div className="att-child" key={r.key} data-row="" data-open={r.children && r.view ? `view:${r.view.id}` : r.open} tabIndex={0}>
              <div className="what">
                <b>{r.title}</b>
                <div>
                  {r.kind} · {r.sub}
                </div>
              </div>
              <span className="when">{ago(r.at, now)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

