import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp, type DrawerType } from "./ctx";
import type { OpsJob, SiteSnapshot } from "../types";
import { JOB, PROBE, cfNoData, cfOk, resumeCall, siteKey } from "../lib/derive";
import { ago, hostOf, ms, shortId, utc } from "../lib/format";
import { NoData, Pill, St } from "../ui/icons";
import { ErrorChart, UptimeFoot, UptimeTicks } from "../ui/charts";
import { jobMeta } from "../views/shared";
import { agentState, nsList } from "../lib/derive";

type Ref = { type: DrawerType; id: string };

function Head({ label, title, sub, badge, onClose }: { label: string; title: string; sub: string; badge?: ReactNode; onClose: () => void }) {
  return (
    <header>
      <div className="grow">
        <div className="label">{label}</div>
        <h2 id="drawerTitle">{title}</h2>
        <div className="mono muted">{sub}</div>
      </div>
      {badge}
      <button type="button" className="btn iconbtn" data-close aria-label="Close" onClick={onClose}>
        ×
      </button>
    </header>
  );
}

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
          <ErrorChart site={s} />
        </div>
        <div>
          <p className="section-title">Probe</p>
          <dl className="kv">
            <dt>Checked</dt>
            <dd>
              {ago(ms(s.checked_at), now)} <span className="faint mono">{utc(ms(s.checked_at))}</span>
            </dd>
            <dt>URL</dt>
            <dd className="mono">
              {s.origin}
              {s.health_path ?? "/"}
            </dd>
            <dt>HTTP status</dt>
            <dd className="mono">{s.http_status ?? "no answer"}</dd>
            <dt>Latency</dt>
            <dd className="mono">{s.latency_ms == null ? "no answer" : `${s.latency_ms} ms`}</dd>
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
                <tbody>
                  {cf.deploys.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{shortId(d.version_id ?? d.id)}</td>
                      <td className="muted">{d.message ?? d.triggered_by ?? ""}</td>
                      <td className="muted">{d.author_email ?? ""}</td>
                      <td className="mono" title={utc(ms(d.created_on))}>
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

function CopyBlock({ id, text, label }: { id: string; text: string; label: string }) {
  const { copy } = useApp();
  return (
    <>
      <div className="cmd" id={id}>
        {text}
      </div>
      <div className="toolbar mt8">
        <button type="button" className="btn" onClick={() => copy(text)}>
          {label}
        </button>
      </div>
    </>
  );
}

function JobBody({ j, onClose }: { j: OpsJob; onClose: () => void }) {
  const { now, feed } = useApp();
  const k = JOB[j.status];
  const prs = feed.live.prs.filter((p) => p.job_id === j.id);
  return (
    <>
      <Head label={`Job · ${j.namespace}`} title={j.title} sub={j.id} badge={<Pill kind={k.kind}>{k.label}</Pill>} onClose={onClose} />
      <div className="dbody">
        {j.status === "blocked" && (
          <>
            <div>
              <p className="section-title">Waits on</p>
              <div className="callout warn">{j.waits_on ?? "No reason was recorded."}</div>
            </div>
            <div>
              <p className="section-title">Run this</p>
              {j.command ? <CopyBlock id="cmdText" text={j.command} label="Copy command" /> : <div className="faint">No command was recorded.</div>}
            </div>
            <div>
              <p className="section-title">Then resume it</p>
              <CopyBlock id="resumeText" text={resumeCall(j)} label="Copy resume call" />
              <p className="faint small">Read only: this page copies the call. The seat, or the summary page at /console, makes it.</p>
            </div>
          </>
        )}
        <div>
          <p className="section-title">Record</p>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <St kind={k.kind}>{k.label}</St> <span className="faint">{jobMeta(j, now)}</span>
            </dd>
            <dt>Priority</dt>
            <dd className="mono">{j.priority}</dd>
            <dt>Posted by</dt>
            <dd className="mono">{j.posted_by}</dd>
            <dt>Created</dt>
            <dd>
              {ago(ms(j.created_at), now)} <span className="faint mono">{utc(ms(j.created_at))}</span>
            </dd>
            <dt>Last change</dt>
            <dd>
              {ago(ms(j.updated_at), now)} <span className="faint mono">{utc(ms(j.updated_at))}</span>
            </dd>
            {j.claimed_by && (
              <>
                <dt>Held by</dt>
                <dd className="mono">{j.claimed_by}</dd>
              </>
            )}
            {j.lease_expires && (
              <>
                <dt>Lease</dt>
                <dd>{ms(j.lease_expires) < now ? <St kind="warn">expired {ago(ms(j.lease_expires), now)}</St> : `expires ${ago(ms(j.lease_expires), now)}`}</dd>
              </>
            )}
            <dt>Blocked / resumed</dt>
            <dd className="mono">
              {j.blocked_count} / {j.resumed_count}
            </dd>
            <dt>Gate required</dt>
            <dd>{j.gate_required ? "yes" : "no"}</dd>
            {j.finding && (
              <>
                <dt>Finding</dt>
                <dd className="mono">{j.finding.fingerprint}</dd>
              </>
            )}
            {j.result_ref && (
              <>
                <dt>Result</dt>
                <dd className="mono">
                  {/^https?:\/\//.test(j.result_ref) ? (
                    <a href={j.result_ref} target="_blank" rel="noopener noreferrer">
                      {j.result_ref}
                    </a>
                  ) : (
                    j.result_ref
                  )}
                </dd>
              </>
            )}
            {prs.map((p) => (
              <FragmentPr key={p.pr_url} url={p.pr_url} merged={p.merged} />
            ))}
          </dl>
        </div>
        <div className="src">
          Source: live, D1 jobs row {j.id}. The mirrored document is {j.namespace}/jobs/{j.id}.md
        </div>
      </div>
    </>
  );
}

function FragmentPr({ url, merged }: { url: string; merged: boolean | null }) {
  return (
    <>
      <dt>Pull request</dt>
      <dd>
        <a href={url} target="_blank" rel="noopener noreferrer">
          {url.replace(/^https:\/\/github\.com\//, "")}
        </a>{" "}
        <span className="faint">{merged === true ? "merged" : merged === false ? "not merged" : "open"}</span>
      </dd>
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
          <dd>{a.last_seen ? <>{ago(ms(a.last_seen), now)} <span className="faint mono">{utc(ms(a.last_seen))}</span></> : "never"}</dd>
          {a.revoked_at && (
            <>
              <dt>Revoked</dt>
              <dd>{utc(ms(a.revoked_at))}</dd>
            </>
          )}
          <dt>Jobs</dt>
          <dd className="mono">
            {a.jobs_done} done · {a.jobs_failed} failed · {a.jobs_blocked} blocked
          </dd>
          <dt>Pull requests</dt>
          <dd className="mono">
            {a.prs_merged} merged of {a.prs_opened} opened
          </dd>
          <dt>CI green</dt>
          <dd className="mono">{a.ci_green_rate == null ? "-" : `${Math.round(a.ci_green_rate * 100)}%`}</dd>
          <dt>Median job</dt>
          <dd className="mono">{a.median_duration_minutes == null ? "-" : `${a.median_duration_minutes} min`}</dd>
          <dt>Flags</dt>
          <dd>{a.flags.join(", ") || "none"}</dd>
        </dl>
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

export function Drawer({ route, onClose }: { route: Ref | null; onClose: () => void }) {
  const { feed, open } = useApp();
  // Keep the last content while the drawer slides out.
  const [shown, setShown] = useState<Ref | null>(route);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const key = route ? `${route.type}:${route.id}` : "";
  useEffect(() => {
    if (route) {
      // Remember what had focus before the drawer opened, once, to hand it back.
      if (!opener.current) opener.current = document.activeElement;
      setShown(route);
      panel.current?.querySelector<HTMLElement>("[data-close]")?.focus();
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
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
  }
  return (
    <>
      <div className={`scrim${route ? " on" : ""}`} onClick={onClose} />
      <aside
        ref={panel}
        className={`drawer${route ? " on" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawerTitle"
        aria-hidden={!route}
        inert={!route}
        onClick={(e) => {
          const el = (e.target as Element).closest<HTMLElement>("[data-open]");
          if (el?.dataset.open && !(e.target as Element).closest("a,button")) open(el.dataset.open);
        }}
      >
        {body}
      </aside>
    </>
  );
}
