import { Empty } from "capsomer/react/empty";
import { useState } from "react";
import { Link } from "wouter";
import { useApp, isView, placePath } from "../app/ctx";
import { attentionGroups, WAITING_KINDS, PROBLEM_ROWS, type AttentionRow } from "../lib/derive";
import { ago } from "../lib/format";
import { St } from "../ui/icons";

// ---- Problems (was Needs attention) ------------------------------------------------------

// What is broken or needs looking at, worst first. What waits on your decision is in the
// list above, so it is left out here.
export function Problems({ sitesOn }: { sitesOn: boolean }) {
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
