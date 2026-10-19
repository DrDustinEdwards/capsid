import { ChartSlot } from "../ui/Enar";
import { Suspense, lazy, useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { isView, placePath, useApp } from "../app/ctx";
import { fetchNamespaces } from "../lib/api";
import { PROBLEM_ROWS, WAITING_KINDS, attentionGroups, hasSites, type AttentionRow, type Kind } from "../lib/derive";
import { age, agentLabel, ago, ms } from "../lib/format";
import { approveAllRequest, approveRequest, canApprove, closeRequest, prAnchor, seatFor } from "../lib/pr-actions";
import type { InboxApp, InboxItem, OpsAwaitingSeat, OpsCanonProposal, OpsJob, PortalNamespace } from "../types";
import { InboxMark, St } from "../ui/icons";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "./shared";

// NEEDS YOU, the home page (docs/design/design-portal-evaluation.md section 4, DECIDE 1,
// ruled 2026-10-09; the UX audit of 2026-10-19, B1, B3 and M3). It answers "what do I have to
// decide" and lets each decision be made here: first everything waiting for you, by kind,
// each row with its own buttons, the existing controls (approve_pr, pr_close, resume_job,
// canon_approve, canon_reject, canon_approve_all, reset_breaker) through the one confirm
// dialog. Then the problems, worst first, what happened since you last looked, and the
// charts last, folded away.

// The inbox's kinds that are not decided on this page by their own control: they open
// where they are fixed. Keyed by string, so an unknown kind still shows under its own name.
const KIND: Record<string, { label: string; kind: Kind } | undefined> = {
  "blocked-job": { label: "Blocked job", kind: "blocked" },
  question: { label: "Question", kind: "blocked" },
  pr: { label: "Pull request", kind: "blocked" },
  report: { label: "Reported", kind: "blocked" },
  proposal: { label: "Proposal", kind: "blocked" },
  ci: { label: "CI failing", kind: "crit" },
  "site-down": { label: "Site down", kind: "crit" },
};

// The digest strip loads after first paint, so the home's first screen is not held up by
// its read.
const SinceLastLooked = lazy(() => import("./Overnight").then((m) => ({ default: m.SinceLastLooked })));
// The two charts load only when Trends is opened: their Enarratio code and their reads stay
// off the first screen.
const MinutesTile = lazy(() => import("./TrendCharts").then((m) => ({ default: m.MinutesTile })));
const WaitingChart = lazy(() => import("./TrendCharts").then((m) => ({ default: m.WaitingChart })));

export function NeedsYou() {
  const { feed } = useApp();
  return (
    <div className="page">
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
function useStops(): { stops: PortalNamespace[]; error: string | null; reread: () => void } {
  const { feed, signOut } = useApp();
  const [state, setState] = useState<{ stops: PortalNamespace[]; error: string | null }>({ stops: [], error: null });
  const [tick, setTick] = useState(0);
  const generated = feed.live.generated;
  useEffect(() => {
    let alive = true;
    void fetchNamespaces().then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setState({ stops: r.value.namespaces.filter((n) => n.breaker.open), error: null });
      if (r.kind === "signed-out") return signOut();
      setState((s) => ({ ...s, error: r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message }));
    });
    return () => {
      alive = false;
    };
  }, [generated, tick, signOut]);
  return { ...state, reread: useCallback(() => setTick((t) => t + 1), []) };
}

function Waiting() {
  const { feed, now } = useApp();
  const inbox = feed.live.inbox;
  const { stops, error, reread } = useStops();
  const all: Entry[] = inbox.apps.flatMap((app) => app.items.map((item) => ({ app, item })));
  const prs = all.filter((e) => e.item.kind === "pr");
  const jobs = all.filter((e) => e.item.kind === "question" || e.item.kind === "blocked-job");
  const other = all.filter((e) => !prs.includes(e) && !jobs.includes(e));
  const canon = feed.live.canon_proposals;
  const total = all.length + canon.length + stops.length;
  const quiet = inbox.apps.filter((a) => a.count === 0);
  return (
    <Panel
      flush
      title="Waiting for you"
      id="waiting"
      count={total}
      src={`read ${ago(ms(inbox.generated), now)}`}
      footer={quiet.length > 0 ? <span className="faint">Nothing waiting: {quiet.map((a) => a.name).join(", ")}</span> : undefined}
    >
      {error && (
        <div className="callout warn" role="status">
          Stopped queues could not be read: {error}
        </div>
      )}
      {total === 0 ? (
        <Empty kind="all-clear" title="Nothing needs you." />
      ) : (
        <>
          {prs.length > 0 && <PrGroup entries={prs} />}
          {jobs.length > 0 && <JobGroup entries={jobs} />}
          {canon.length > 0 && <CanonGroup list={canon} />}
          {stops.length > 0 && <StopGroup list={stops} onReset={reread} />}
          {other.length > 0 && <OtherGroup entries={other} />}
        </>
      )}
    </Panel>
  );
}

// One kind's rows under its heading. With batch, the heading carries a "select all" box and,
// once a row is ticked, the button that decides the ticked rows together.
function Group({ id, title, count, batch, children }: { id: string; title: string; count: number; batch?: ReactNode; children: ReactNode }) {
  return (
    <section className="wgroup" aria-labelledby={`${id}-h`} data-group={id}>
      <div className="wgroup-head">
        <h3 id={`${id}-h`}>
          {title} <span className="num faint">{count}</span>
        </h3>
        {batch}
      </div>
      <ul className="wlist">{children}</ul>
    </section>
  );
}

// The ticked keys of one group, kept to the rows still shown.
function useTicks(keys: string[]): { ticked: string[]; has: (k: string) => boolean; flip: (k: string) => void; all: (on: boolean) => void } {
  const [set, setSet] = useState<ReadonlySet<string>>(new Set());
  const ticked = keys.filter((k) => set.has(k));
  return {
    ticked,
    has: (k) => set.has(k),
    flip: (k) => setSet((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k]))),
    all: (on) => setSet(on ? new Set(keys) : new Set()),
  };
}

function SelectAll({ label, keys, ticks }: { label: string; keys: string[]; ticks: ReturnType<typeof useTicks> }) {
  const n = ticks.ticked.length;
  return (
    <label className="wselect">
      <input
        type="checkbox"
        checked={n > 0 && n === keys.length}
        ref={(el) => {
          if (el) el.indeterminate = n > 0 && n < keys.length;
        }}
        onChange={(e) => ticks.all(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Tick({ label, on, flip }: { label: string; on: boolean; flip: () => void }) {
  return (
    <label className="wtick">
      <input type="checkbox" checked={on} onChange={flip} />
      <span className="sr-only">{label}</span>
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
  const ticks = useTicks(keys);
  const chosen = approvable.filter((a) => ticks.has(prAnchor(a)));
  return (
    <Group
      id="w-prs"
      title="Pull requests"
      count={entries.length}
      batch={
        approvable.length > 1 && (
          <div className="wbatch">
            <SelectAll label="Select all" keys={keys} ticks={ticks} />
            {chosen.length > 0 && (
              <button type="button" className="btn primary" onClick={() => confirm({ ...approveAllRequest(chosen), onDone: () => ticks.all(false) })}>
                Approve {chosen.length} selected
              </button>
            )}
          </div>
        )
      }
    >
      {rows.map(({ app, item, seat }, i) => (
        <PrRow key={`${item.link ?? item.title}|${i}`} app={app} item={item} seat={seat} ticks={approvable.length > 1 ? ticks : null} />
      ))}
    </Group>
  );
}

function PrRow({ app, item, seat, ticks }: { app: InboxApp; item: InboxItem; seat: OpsAwaitingSeat | undefined; ticks: ReturnType<typeof useTicks> | null }) {
  const { now, confirm } = useApp();
  const name = seat ? `${seat.repo} #${seat.number}` : item.title;
  const ok = seat && canApprove(seat) ? seat : null;
  return (
    <li className="wrow" data-row="" data-kind="pr" id={seat ? `w-${prAnchor(seat)}` : undefined}>
      {ticks && ok ? <Tick label={`Select ${name}`} on={ticks.has(prAnchor(ok))} flip={() => ticks.flip(prAnchor(ok))} /> : ticks ? <span className="wtick" /> : null}
      <div className="wmain">
        <b>{item.title}</b>
        <Meta>
          {app.name} · waiting {age(ms(item.since), now)}
          {seat?.why ? ` · ${seat.why}` : ""}
        </Meta>
        {item.link && <GitHub href={item.link} />}
      </div>
      <div className="wact">
        {ok && (
          <button type="button" className="btn primary" aria-label={`Approve ${name}`} onClick={() => confirm(approveRequest(ok))}>
            Approve
          </button>
        )}
        {seat && (
          <button type="button" className="btn" aria-label={`Close ${name}`} onClick={() => confirm(closeRequest(seat))}>
            Close
          </button>
        )}
        {seat && !ok && <span className="faint wnote">{seat.class === "typed" ? "Approve it by typing its number in chat." : "Not approvable here."}</span>}
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
  const [reply, setReply] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const id = useId();
  const box = `${id}-reply`;
  const blocked = j?.status === "blocked";
  const send = () => {
    const text = reply.trim();
    if (!text) return setHint(question ? "Type your answer first." : "Say what you did or approved first.");
    if (!j) return;
    setHint(null);
    confirm({ action: "resume_job", params: { id: j.id, reason: text }, title: `${question ? "Answer" : "Resume job"}: ${j.title}`, onDone: () => (setReplying(false), setReply("")) });
  };
  return (
    <li className="wrow" data-row="" data-kind={question ? "question" : "blocked-job"} data-job={item.job}>
      <div className="wmain">
        <InboxMark kind={question ? "question" : "blocked-job"} tone="warn">
          {question ? "Question" : "Blocked"}
        </InboxMark>
        <b>{item.title}</b>
        {j?.waits_on && <p className="wask">{question ? `Asks: ${asks(j)}` : `Waits on: ${j.waits_on}`}</p>}
        <Meta>
          {app.name} · waiting {age(ms(item.since), now)}
          {j?.claimed_by ? ` · ${agentLabel(j.claimed_by)}` : ""}
        </Meta>
        <span className="wlinks">
          {j && (
            <button type="button" className="linkbtn wlink" onClick={() => open(`job:${j.id}`)}>
              More about this job
            </button>
          )}
          {item.link && <GitHub href={item.link} />}
        </span>
        {replying && (
          <form
            className="wreply"
            id={box}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor={`${box}-text`}>{question ? "Your answer, sent to its driver" : "What you did or approved, sent to its driver"}</label>
            <textarea id={`${box}-text`} rows={3} value={reply} autoFocus aria-invalid={hint ? true : undefined} aria-describedby={hint ? `${box}-hint` : undefined} onChange={(e) => (setReply(e.target.value), setHint(null))} />
            {hint && (
              <span className="err" id={`${box}-hint`} role="alert">
                {hint}
              </span>
            )}
            <div className="toolbar">
              <button type="submit" className="btn primary">
                Send
              </button>
              <button type="button" className="btn" onClick={() => (setReplying(false), setHint(null))}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="wact">
        {blocked && !replying && (
          <button type="button" className="btn primary" aria-label={`${verb} ${item.title}`} onClick={() => setReplying(true)}>
            {verb}
          </button>
        )}
        {!blocked && j && <span className="faint wnote">{`Now ${j.status}.`}</span>}
      </div>
    </li>
  );
}

// ---- rule changes (canon proposals)

function CanonGroup({ list }: { list: OpsCanonProposal[] }) {
  const { confirm } = useApp();
  const fresh = list.filter((c) => !c.stale);
  const keys = fresh.map((c) => String(c.id));
  const ticks = useTicks(keys);
  const chosen = fresh.filter((c) => ticks.has(String(c.id)));
  return (
    <Group
      id="w-rules"
      title="Rule changes"
      count={list.length}
      batch={
        <div className="wbatch">
          {fresh.length > 1 && <SelectAll label="Select all" keys={keys} ticks={ticks} />}
          {chosen.length > 0 ? (
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                confirm({
                  action: "canon_approve",
                  params: { id: String(chosen[0]!.id) },
                  title: `Approve ${chosen.length} rule ${chosen.length === 1 ? "change" : "changes"}`,
                  batch: chosen.map((c) => ({ action: "canon_approve", params: { id: String(c.id) }, label: `${c.namespace}/${c.path} (${c.id})` })),
                  onDone: () => ticks.all(false),
                })
              }
            >
              Approve {chosen.length} selected
            </button>
          ) : (
            // Every pending proposal in one decision (canon_approve_all): its preview lists each one's outcome.
            <button type="button" className="btn" onClick={() => confirm({ action: "canon_approve_all", params: {}, title: "Decide every rule change" })}>
              Approve all
            </button>
          )}
        </div>
      }
    >
      {list.map((c) => (
        <CanonRow key={c.id} c={c} ticks={fresh.length > 1 ? ticks : null} />
      ))}
    </Group>
  );
}

function CanonRow({ c, ticks }: { c: OpsCanonProposal; ticks: ReturnType<typeof useTicks> | null }) {
  const { now, confirm } = useApp();
  const target = `${c.namespace}/${c.path}`;
  const flagged = c.directive_lines.length;
  return (
    <li className="wrow" data-row="" data-canon={c.id}>
      {ticks && !c.stale ? <Tick label={`Select the change to ${target}`} on={ticks.has(String(c.id))} flip={() => ticks.flip(String(c.id))} /> : ticks ? <span className="wtick" /> : null}
      <div className="wmain">
        {c.stale ? <St kind="blocked">Out of date</St> : flagged ? <St kind="warn">Read closely</St> : null}
        <b>{target}</b>
        <Meta>
          {agentLabel(c.proposer)} · {c.creates ? "a new document" : `${c.added} lines added, ${c.removed} removed`} · {ago(ms(c.created_at), now)}
          {flagged ? ` · ${flagged} ${flagged === 1 ? "line reads" : "lines read"} as instructions to agents` : ""}
          {c.stale ? " · the document changed since, so it can only be rejected" : ""}
        </Meta>
      </div>
      <div className="wact">
        {!c.stale && (
          <button type="button" className="btn primary" aria-label={`Review the change to ${target}`} onClick={() => confirm({ action: "canon_approve", params: { id: String(c.id) }, title: `Approve the change to ${target}` })}>
            Review
          </button>
        )}
        <button type="button" className="btn" aria-label={`Reject the change to ${target}`} onClick={() => confirm({ action: "canon_reject", params: { id: String(c.id) }, title: `Reject the change to ${target}` })}>
          Reject
        </button>
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
            <St kind="crit">Paused</St>
            <b>{n.namespace}</b>
            <Meta>
              {n.breaker.failed} jobs failed since {n.breaker.since} UTC. No job here starts until you reset it.
            </Meta>
          </div>
          <div className="wact">
            <button type="button" className="btn primary" aria-label={`Reset ${n.namespace}`} onClick={() => confirm({ action: "reset_breaker", params: { namespace: n.namespace }, title: `Restart the queue for ${n.namespace}`, onDone: onReset })}>
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
        const k = KIND[item.kind] ?? { label: item.kind, kind: "blocked" as const };
        return (
          <li className="wrow" key={`${item.kind}|${item.title}|${i}`} data-kind={item.kind}>
            <div className="wmain">
              <InboxMark kind={item.kind} tone={k.kind === "blocked" ? "warn" : k.kind}>
                {k.label}
              </InboxMark>
              {item.link ? (
                <a className="wtitle" href={item.link} target="_blank" rel="noreferrer noopener">
                  {item.title}
                </a>
              ) : (
                <b>{item.title}</b>
              )}
              <Meta>
                {app.name} · {ago(ms(item.since), now)}
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
    <Panel title="Weekly digest" id="weekly-digest" section="Weekly digest" count={open.length} src="watcher findings that post no job">
      {sites.map((site) => (
        <section className="wgroup" key={site} aria-label={`Weekly digest, ${site}`} data-digest-site={site}>
          <div className="wgroup-head">
            <h3>
              {site}
              <span className="num faint"> {open.filter((f) => f.namespace === site).length} open</span>
            </h3>
          </div>
          <ul className="wlist">
            {open
              .filter((f) => f.namespace === site)
              .map((f) => (
                <li className="wrow" key={f.fingerprint} title={f.evidence.join("\n")}>
                  <span className="wmain">
                    <b>{f.headline}</b>
                    <span className="wmeta">since {ago(ms(f.first_seen), now)}</span>
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
// moves. Opened, the body keeps room for the charts while they load (styles.css, .trends).
function Trends() {
  const [open, setOpen] = useState(false);
  return (
    <details className="trends" id="trends" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="chev" aria-hidden="true" />
        Trends <span className="faint">your time per week, and where waiting goes</span>
      </summary>
      <div className="trends-body chart-row">
        {open && (
          <>
            <ChartSlot>
              <MinutesTile />
            </ChartSlot>
            <ChartSlot>
              <WaitingChart />
            </ChartSlot>
          </>
        )}
      </div>
    </details>
  );
}

// ---- Problems (was Needs attention) ------------------------------------------------------

// What is broken or needs looking at, worst first. What waits on your decision is in the
// list above, so it is left out here.
function Problems({ sitesOn }: { sitesOn: boolean }) {
  const { feed, now } = useApp();
  const { problems, notices, noticeCount } = attentionGroups(feed, now, WAITING_KINDS);
  const [more, setMore] = useState(false);
  // Every critical row is shown; warnings fill the rest of the first PROBLEM_ROWS.
  const crit = problems.filter((p) => p.sev === "crit");
  const room = Math.max(0, PROBLEM_ROWS - crit.length);
  const warn = problems.filter((p) => p.sev !== "crit");
  const hidden = warn.length > room ? warn.slice(room) : [];
  const shown = [...crit, ...(hidden.length ? warn.slice(0, room) : warn)];
  return (
    <section className="attention" id="attention" data-section="Problems" aria-labelledby="attH">
      <header>
        <h2 id="attH">Problems</h2>
        <span className="num faint">{problems.length ? `${problems.length} ${problems.length === 1 ? "problem" : "problems"}, worst first` : "no problems"}</span>
        <span className="src ml-auto">{sitesOn ? "sites, " : ""}backups, CI, watcher, agents</span>
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
        <Empty kind="all-clear" title="No problems." />
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
                <Link href={placePath(view.id)}>{(row.total ?? 0) > kids.length ? `All ${row.total} in ${view.label}` : `Open ${view.label}`}</Link>
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
