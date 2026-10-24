import { ChartSlot } from "../ui/Enar";
import { Fragment, lazy, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Spinner } from "capsomer/react/empty";
import { useApp, type DrawerType } from "./ctx";
import type { SiteSnapshot } from "../types";
import { fetchActivity, useAnswer } from "../lib/api";
import { actionWords } from "../lib/audit-words";
import { JOB, PROBE, cfNoData, cfOk, siteKey } from "../lib/derive";
import { ago, hostOf, ms, shortId, utc } from "../lib/format";
import { NoData, Pill, St } from "../ui/icons";
import { When } from "../ui/When";
import { UptimeFoot, UptimeTicks } from "../ui/charts";
import { agentState, nsList } from "../lib/derive";
import { AgentControls, Head, JobBody } from "./DrawerJob";

// Chart 9 (error rate with deploy markers) is an Enarratio line chart, loaded when a site's
// drawer opens so it stays out of the initial bundle.
const ErrorRate = lazy(() => import("../views/TrendCharts").then((m) => ({ default: m.ErrorRate })));

type Ref = { type: DrawerType; id: string };

function Missing({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <>
      <Head label="Not found" title={what} sub="" onClose={onClose} />
      <div className="dbody">
        <div className="callout">It is not in the current feed. It may have ended more than 24 hours ago, or the watcher has not seen it yet.</div>
      </div>
    </>
  );
}

function SiteBody({ s, onClose }: { s: SiteSnapshot; onClose: () => void }) {
  const { now } = useApp();
  const p = PROBE[s.state];
  const cf = cfOk(s);
  const detail = s.error ?? (s.state === "liveness" ? "No health route; a root 200 is liveness only." : s.state !== "ok" ? p.label : null);
  return (
    <>
      <Head label={`Site · ${s.namespace}`} title={s.name} sub={hostOf(s.origin)} badge={<Pill kind={p.kind}>{p.label}</Pill>} onClose={onClose} />
      <div className="dbody">
        {detail && <div className={`callout ${s.state === "down" ? "crit" : s.state === "degraded" ? "warn" : ""}`}>{detail}</div>}
        <div>
          <p className="section-title">Uptime, 7 days</p>
          <UptimeTicks site={s} />
          <UptimeFoot site={s} long />
        </div>
        <div>
          <p className="section-title">Requests and error rate, 24 hours</p>
          <ChartSlot>
            <ErrorRate site={s} />
          </ChartSlot>
        </div>
        <div>
          <p className="section-title">Probe</p>
          <dl className="kv">
            <dt>Checked</dt>
            <dd>
              {ago(ms(s.checked_at), now)} <When t={ms(s.checked_at)} />
            </dd>
            <dt>URL</dt>
            <dd className="mono">
              {s.origin}
              {s.health_path ?? "/"}
            </dd>
            <dt>HTTP status</dt>
            <dd className="num">{s.http_status ?? "no answer"}</dd>
            <dt>Latency</dt>
            <dd className="num">{s.latency_ms == null ? "no answer" : `${s.latency_ms} ms`}</dd>
            <dt>Reports sha</dt>
            <dd className="mono">{s.sha ?? <span className="faint">not reported</span>}</dd>
            <dt>Platform</dt>
            <dd>{s.platform === "vercel" ? "Vercel" : "Cloudflare"}</dd>
            <dt>Cloudflare script</dt>
            <dd className="mono">{cf ? cf.script : <NoData reason={cfNoData(s.cloudflare) ?? ""} />}</dd>
          </dl>
        </div>
        <div>
          <p className="section-title">Deploys</p>
          {!cf ? (
            <div className="faint">No data: {cfNoData(s.cloudflare)}</div>
          ) : cf.deploys.length ? (
            <div className="scroll-x">
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Message</th>
                    <th scope="col">Author</th>
                    <th scope="col">When</th>
                  </tr>
                </thead>
                <tbody>
                  {cf.deploys.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{shortId(d.version_id ?? d.id)}</td>
                      <td className="muted">{d.message ?? d.triggered_by ?? ""}</td>
                      <td className="muted">{d.author_email ?? ""}</td>
                      <td className="num" title={utc(ms(d.created_on))}>
                        {ago(ms(d.created_on), now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="faint">No deploys recorded.</div>
          )}
        </div>
        <div>
          <p className="section-title">Open elsewhere</p>
          <div className="toolbar">
            <a className="btn" href={s.origin} target="_blank" rel="noopener noreferrer">
              Site
            </a>
            {s.health_path && (
              <a className="btn" href={`${s.origin}${s.health_path}`} target="_blank" rel="noopener noreferrer">
                Health route
              </a>
            )}
          </div>
        </div>
        <div className="src">Source: watcher pass, KV ops:snapshot, sites[{s.name}]</div>
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
          <div className="callout">There is no audit row with this id. Rows older than the retention are pruned after the nightly dump.</div>
        </div>
      </>
    );
  }
  const d = r.detail;
  return (
    <>
      <Head label={`Audit row · ${r.namespace ?? "no namespace"}`} title={actionWords(r.action) ?? r.action ?? "no action"} sub={`#${r.id} · ${r.action ?? "no action"} · ${r.actor ?? "no actor"}`} onClose={onClose} />
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
              {ago(ms(r.at), now)} <When t={ms(r.at)} />
            </dd>
            <dt>Actor</dt>
            <dd className="mono">{r.actor ?? <span className="faint">none</span>}</dd>
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
          {d.unreadable && <p className="faint">This row's recorded detail is not JSON, so it cannot be shown. Rows this old predate that rule.</p>}
          {d.withheld > 0 && (
            <p className="faint">
              {d.withheld} recorded {d.withheld === 1 ? "field is" : "fields are"} not shown: hashes, signatures and nested values stay in the audit log.
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
  const mine = feed.live.jobs.filter((j) => j.claimed_by === `agent:${a.name}` || j.claimed_by === a.name);
  return (
    <>
      <Head label={`Agent · ${a.kind}`} title={a.name} sub={`agent:${a.name}`} badge={<Pill kind={st.kind}>{st.label}</Pill>} onClose={onClose} />
      <div className="dbody">
        <dl className="kv">
          <dt>Namespaces</dt>
          <dd className="mono">{nsList(a)}</dd>
          <dt>Last seen</dt>
          <dd>{a.last_seen ? <>{ago(ms(a.last_seen), now)} <When t={ms(a.last_seen)} /></> : "never"}</dd>
          {a.revoked_at && (
            <>
              <dt>Revoked</dt>
              <dd>
                <When t={ms(a.revoked_at)} />
              </dd>
            </>
          )}
          {a.archived_at && (
            <>
              <dt>Archived</dt>
              <dd>
                <When t={ms(a.archived_at)} />
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
          <dd className="num">{a.ci_green_rate == null ? "-" : `${Math.round(a.ci_green_rate * 100)}%`}</dd>
          <dt>Median job</dt>
          <dd className="num">{a.median_duration_minutes == null ? "-" : `${a.median_duration_minutes} min`}</dd>
          <dt>Flags</dt>
          <dd>{a.flags.join(", ") || "none"}</dd>
        </dl>
        <AgentControls a={a} />
        <div>
          <p className="section-title">Holding now</p>
          {mine.length ? (
            mine.map((j) => (
              <div className="qrow" key={j.id} data-open={`job:${j.id}`} tabIndex={0}>
                <St kind={JOB[j.status].kind}>{JOB[j.status].label}</St>
                <div className="t">
                  <b>{j.title}</b>
                </div>
                <div className="m">{ago(ms(j.updated_at), now)}</div>
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

// The detail panel: a native modal <dialog> opened with showModal(), so the page behind
// is inert and Tab stays inside (audit DECIDE 9). The route drives it: an address
// /<view>/<type>/<id> opens it, and closing it (Close, Esc, a click on the backdrop)
// navigates back to /<view>. It slides in from the right (styles.css, drawer), and focus
// returns to the row that opened it.
export function Drawer({ route, onClose }: { route: Ref | null; onClose: () => void }) {
  const { feed, open } = useApp();
  // Keep the last content while the drawer slides out.
  const [shown, setShown] = useState<Ref | null>(route);
  const panel = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const routed = useRef(route != null);
  routed.current = route != null;
  const key = route ? `${route.type}:${route.id}` : "";
  useEffect(() => {
    const d = panel.current;
    if (!d) return;
    if (route) {
      // Remember what had focus before the drawer opened, once, to hand it back.
      if (!d.open) {
        opener.current = document.activeElement;
        d.showModal();
      }
      setShown(route);
      d.querySelector<HTMLElement>("[data-close]")?.focus();
    } else if (d.open) {
      d.close();
      // Back to the row that opened it; when that is gone, or sat in a dialog since closed
      // (the command menu), to the view.
      const from = opener.current;
      const back = from instanceof HTMLElement && from.isConnected && !from.closest("dialog:not([open])") ? from : document.querySelector<HTMLElement>("main");
      back?.focus();
      opener.current = null;
    }
  }, [key]);
  const ref = route ?? shown;
  let body: ReactNode = null;
  if (ref?.type === "site") {
    const s = feed.snapshot?.sites.find((x) => siteKey(x) === ref.id);
    body = s ? <SiteBody s={s} onClose={onClose} /> : <Missing what={`Site ${ref.id}`} onClose={onClose} />;
  } else if (ref?.type === "job") {
    const j = feed.live.jobs.find((x) => x.id === ref.id);
    body = j ? <JobBody j={j} onClose={onClose} /> : <Missing what={`Job ${ref.id}`} onClose={onClose} />;
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
    <dialog
      ref={panel}
      className="drawer"
      aria-labelledby="drawerTitle"
      onCancel={(e) => {
        // Esc: the route closes the dialog, so the address and the panel stay one thing.
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        // Closed some other way while the address still names it: follow the address.
        if (routed.current) onClose();
      }}
      onClick={(e) => {
        const d = panel.current;
        if (d && e.target === d) {
          // A click on the dialog element itself outside its box is the backdrop.
          const r = d.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return onClose();
        }
        openRow(e);
      }}
      onKeyDown={(e) => {
        // Enter on a focused row: cancel its default so the new panel's Close button is
        // not activated by the same key.
        if (e.key === "Enter" && openRow(e)) e.preventDefault();
      }}
    >
      {body}
    </dialog>
  );
}
