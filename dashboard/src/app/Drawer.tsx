import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Dialog } from "capsomer/react/dialog";
import { Missing as NoValue, Spinner } from "capsomer/react/empty";
import { useApp, type DrawerType } from "./ctx";
import { fetchActivity, useAnswer } from "../lib/api";
import { actionWords } from "../lib/audit-words";
import { JOB } from "../lib/derive";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import { Pill, St } from "../ui/icons";
import { Time } from "capsomer/react/time";
import { agentState, nsList } from "../lib/derive";
import { AgentControls, Head, JobBody } from "./DrawerJob";

type Ref = { type: DrawerType; id: string };

function Missing({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <>
      <Head label="Not found" title={what} sub="" onClose={onClose} />
      <div className="dbody">
        <div className="callout">
          It is not in the current feed. It may have ended more than 24 hours ago, or the watcher
          has not seen it yet.
        </div>
      </div>
    </>
  );
}

// One audit row (GET /portal/api/activity?id=), read when the drawer opens: the reason
// typed with the change, a field-by-field before and after, and the row's other fields
// by name (src/audit-detail.ts). Never the raw params.
function AuditBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { now } = useApp();
  const load = useAnswer(["activity", "row", id], () => fetchActivity({ id }), { keep: false });
  if (!load.data && load.loading) {
    return (
      <>
        <Head label="Audit row" title={`#${id}`} sub="" onClose={onClose} />
        <div className="dbody">
          <div className="loading" role="status">
            <Spinner label="Reading the row..." />
          </div>
        </div>
      </>
    );
  }
  if (!load.data) {
    return (
      <>
        <Head label="Audit row" title={`#${id}`} sub="" onClose={onClose} />
        <div className="dbody">
          <div className="callout crit" role="alert">
            Could not read the row: {load.error}
          </div>
        </div>
      </>
    );
  }
  const r = load.data.rows[0];
  if (!r) {
    return (
      <>
        <Head label="Not found" title={`Audit row #${id}`} sub="" onClose={onClose} />
        <div className="dbody">
          <div className="callout">
            There is no audit row with this id. Rows older than the retention are pruned after the
            nightly dump.
          </div>
        </div>
      </>
    );
  }
  const d = r.detail;
  return (
    <>
      <Head
        label={`Audit row · ${r.namespace ?? "no namespace"}`}
        title={actionWords(r.action) ?? r.action ?? "no action"}
        sub={`#${r.id} · ${r.action ?? "no action"} · ${r.actor ?? "no actor"}`}
        onClose={onClose}
      />
      <div className="dbody">
        {d.reason !== null && (
          <div>
            <p className="section-title">Reason</p>
            <div className="callout reason">{d.reason}</div>
          </div>
        )}
        {d.changes !== null && (
          <div>
            <p className="section-title">What changed</p>
            {d.changes.length === 0 ? (
              <p className="faint">No field changed.</p>
            ) : (
              <dl className="kv diff">
                {d.changes.map((c) => (
                  <Fragment key={c.field}>
                    <dt>{c.field}</dt>
                    <dd>
                      {c.before !== null && (
                        <del className="mono" aria-label={`before: ${c.before}`}>
                          {c.before}
                        </del>
                      )}
                      {c.after !== null ? (
                        <ins className="mono" aria-label={`after: ${c.after}`}>
                          {c.after}
                        </ins>
                      ) : (
                        <span className="faint">removed</span>
                      )}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </div>
        )}
        <div>
          <p className="section-title">Recorded</p>
          <dl className="kv">
            <dt>When</dt>
            <dd>
              {ago(parse(r.at), now)} <Time at={r.at} format="exact" />
            </dd>
            <dt>Actor</dt>
            <dd className="mono">{r.actor ?? <NoValue />}</dd>
            {r.client && (
              <>
                <dt>Via</dt>
                <dd>{r.client}</dd>
              </>
            )}
            {r.path && (
              <>
                <dt>Path</dt>
                <dd className="mono wrap">{r.path}</dd>
              </>
            )}
            {d.fields.map((f) => (
              <Fragment key={f.name}>
                <dt>{f.name}</dt>
                <dd className="mono wrap">{f.value}</dd>
              </Fragment>
            ))}
          </dl>
          {d.unreadable && (
            <p className="faint">
              This row's recorded detail is not JSON, so it cannot be shown. Rows this old predate
              that rule.
            </p>
          )}
          {d.withheld > 0 && (
            <p className="faint">
              {d.withheld} recorded {d.withheld === 1 ? "field is" : "fields are"} not shown:
              hashes, signatures and nested values stay in the audit log.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function AgentBody({ name, onClose }: { name: string; onClose: () => void }) {
  const { feed, now } = useApp();
  const a = feed.live.agents.find((x) => x.name === name);
  if (!a) return <Missing what={`Agent ${name}`} onClose={onClose} />;
  const st = agentState(a, now);
  const mine = feed.live.jobs.filter(
    (j) => j.claimed_by === `agent:${a.name}` || j.claimed_by === a.name,
  );
  return (
    <>
      <Head
        label={`Agent · ${a.kind}`}
        title={a.name}
        sub={`agent:${a.name}`}
        badge={<Pill kind={st.kind}>{st.label}</Pill>}
        onClose={onClose}
      />
      <div className="dbody">
        <dl className="kv">
          <dt>Namespaces</dt>
          <dd className="mono">{nsList(a)}</dd>
          <dt>Last seen</dt>
          <dd>
            {a.last_seen ? (
              <>
                {ago(parse(a.last_seen), now)} <Time at={a.last_seen} format="exact" />
              </>
            ) : (
              "never"
            )}
          </dd>
          {a.revoked_at && (
            <>
              <dt>Revoked</dt>
              <dd>
                <Time at={a.revoked_at} format="exact" />
              </dd>
            </>
          )}
          {a.archived_at && (
            <>
              <dt>Archived</dt>
              <dd>
                <Time at={a.archived_at} format="exact" />
              </dd>
            </>
          )}
          <dt>Jobs</dt>
          <dd className="num">
            {a.jobs_done} done · {a.jobs_failed} failed · {a.jobs_blocked} blocked
          </dd>
          <dt>Pull requests</dt>
          <dd className="num">
            {a.prs_merged} merged of {a.prs_opened} opened
          </dd>
          <dt>CI green</dt>
          <dd className="num">
            {a.ci_green_rate == null ? "-" : `${Math.round(a.ci_green_rate * 100)}%`}
          </dd>
          <dt>Median job</dt>
          <dd className="num">
            {a.median_duration_minutes == null ? "-" : `${a.median_duration_minutes} min`}
          </dd>
          <dt>Flags</dt>
          <dd>{a.flags.join(", ") || "none"}</dd>
        </dl>
        <AgentControls a={a} />
        <div>
          <p className="section-title">Holding now</p>
          {mine.length ? (
            mine.map((j) => (
              <div className="qrow" key={j.id} data-open={`job:${j.id}`} role="button" tabIndex={0}>
                <St kind={JOB[j.status].kind}>{JOB[j.status].label}</St>
                <div className="t">
                  <b>{j.title}</b>
                </div>
                <div className="m">{ago(parse(j.updated_at), now)}</div>
              </div>
            ))
          ) : (
            <div className="faint">Nothing claimed or blocked.</div>
          )}
        </div>
      </div>
    </>
  );
}

// The detail panel: Capsomer's Dialog as a side sheet on the right (native showModal, so the page
// behind is inert and Tab stays inside, audit DECIDE 9). The route drives it: an address
// /<view>/<type>/<id> opens it, and closing it (Close, Esc, a click on the backdrop) navigates back
// to /<view>. Focus returns to the row that opened it, or to the view when that row is gone.
export function Drawer({ route, onClose }: { route: Ref | null; onClose: () => void }) {
  const { feed, open } = useApp();
  // Keep the last content while the drawer slides out.
  const [shown, setShown] = useState<Ref | null>(route);
  if (route && (shown?.type !== route.type || shown.id !== route.id)) setShown(route);
  const routed = useRef(route != null);
  useEffect(() => {
    routed.current = route != null;
  });
  const ref = route ?? shown;
  let body: ReactNode = null;
  if (ref?.type === "job") {
    const j = feed.live.jobs.find((x) => x.id === ref.id);
    body = j ? (
      <JobBody j={j} onClose={onClose} />
    ) : (
      <Missing what={`Job ${ref.id}`} onClose={onClose} />
    );
  } else if (ref?.type === "agent") {
    body = <AgentBody name={ref.id} onClose={onClose} />;
  } else if (ref?.type === "audit") {
    body = <AuditBody key={ref.id} id={ref.id} onClose={onClose} />;
  }
  // A row inside the drawer (an agent's "Holding now") opens by click or by Enter.
  const openRow = (e: ReactMouseEvent | ReactKeyboardEvent): boolean => {
    const t = e.target as Element;
    const el = t.closest<HTMLElement>("[data-open]");
    if (!el?.dataset.open || t.closest("a,button")) return false;
    open(el.dataset.open);
    return true;
  };
  return (
    <Dialog
      open={route != null}
      // Closed by Esc, the backdrop or Back while the address still names it: follow the address.
      onOpenChange={(o) => {
        if (!o && routed.current) onClose();
      }}
      placement="right"
      closeButton={false}
      className="drawer"
      aria-labelledby="drawerTitle"
      onClick={(e) => {
        openRow(e);
      }}
      onKeyDown={(e) => {
        // Enter on a focused row: cancel its default so the new panel's Close button is
        // not activated by the same key.
        if (e.key === "Enter" && openRow(e)) e.preventDefault();
      }}
    >
      {body}
    </Dialog>
  );
}
