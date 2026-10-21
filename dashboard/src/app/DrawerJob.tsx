import type { ReactNode } from "react";
import { JOB, resumeCall } from "../lib/derive";
import { ago, ms } from "../lib/format";
import type { OpsJob, OpsAgent } from "../types";
import { Pill, St } from "../ui/icons";
import { When } from "../ui/When";
import { Danger, jobMeta } from "../views/shared";
import { useApp, type ConfirmRequest } from "./ctx";

export function Head({ label, title, sub, badge, onClose }: { label: string; title: string; sub: string; badge?: ReactNode; onClose: () => void }) {
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

// Whether supersede may end the job: a queued one, or a claimed one with no work
// recorded yet (src/jobs-seat.ts, supersedeJob). The Worker checks again.
function supersedable(j: OpsJob): boolean {
  if (j.status === "queued") return true;
  return j.status === "claimed" && j.blocked_count === 0 && j.resumed_count === 0 && j.result_ref === null;
}

// The controls a job's status allows. Each opens the confirm dialog, which asks for a
// reason and shows what changes before anything is written.
function JobControls({ j }: { j: OpsJob }) {
  const { confirm } = useApp();
  const params = { id: j.id };
  const blocked = j.status === "blocked";
  const claimed = j.status === "claimed";
  const queued = j.status === "queued";
  if (j.status === "parked") {
    return (
      <div>
        <p className="section-title">Change it</p>
        <div className="toolbar">
          <button
            type="button"
            className="btn primary"
            onClick={() => confirm({ action: "unpark_job", params, title: `Unpark job: ${j.title}`, undo: { action: "park_job", params: { id: j.id, reason: j.parked_reason ?? "parked again", undo: "true" } } })}
          >
            Unpark
          </button>
        </div>
        <p className="faint small">Unpark puts it back in the queue at its priority. The result offers Undo.</p>
      </div>
    );
  }
  const failable = blocked || claimed || queued;
  if (!failable) return null;
  // One primary action for the state the job is in, the other safe ones under More
  // actions, and Mark failed alone in the Danger area (the UX audit's M9: it sat beside
  // Close as shipped and Resume in a row of up to six).
  const resume = { action: "resume_job" as const, params, title: `${j.question ? "Answer" : "Resume job"}: ${j.title}` };
  const release = { action: "release_job" as const, params, title: `Release job: ${j.title}` };
  const park = { action: "park_job" as const, params, title: `Park job: ${j.title}`, undo: { action: "unpark_job" as const, params: { id: j.id, undo: "true" } } };
  const primary = blocked ? { req: resume, label: j.question ? "Answer" : "Resume" } : claimed ? { req: release, label: "Release" } : { req: park, label: "Park" };
  const more: Array<{ label: string; req: ConfirmRequest }> = [
    ...(blocked ? [{ label: "Close as shipped", req: { action: "close_shipped" as const, params, title: `Close as shipped: ${j.title}` } }] : []),
    ...(supersedable(j) ? [{ label: "Supersede", req: { action: "supersede_job" as const, params, title: `Supersede job: ${j.title}` } }] : []),
  ];
  return (
    <div className="stack-gap" data-job-controls="">
      <div>
        <p className="section-title">Change it</p>
        <div className="toolbar">
          <button type="button" className="btn primary" onClick={() => confirm(primary.req)}>
            {primary.label}
          </button>
        </div>
        <p className="faint small">
          {blocked
            ? j.question
              ? "Answer sends your reply to its driver as the resume note."
              : "Resume sends it back to its driver."
            : claimed
              ? "Release takes it from its holder and puts it back in the queue."
              : "Park keeps it out of the queue until you unpark it; its reason says when it comes back."}{" "}
          Each asks for a reason and shows what changes first.
        </p>
      </div>
      {more.length > 0 && (
        <details className="more-actions">
          <summary className="btn">
            <span className="chev" aria-hidden="true" />
            More actions
          </summary>
          <div className="toolbar mt8">
            {more.map((m) => (
              <button key={m.label} type="button" className="btn" onClick={() => confirm(m.req)}>
                {m.label}
              </button>
            ))}
          </div>
          <p className="faint small">
            {blocked ? "Close as shipped ends it as done when its work already landed, credited to the driver. " : ""}
            {supersedable(j) ? "Supersede ends a job replaced before any work was done, with no outcome against anybody." : ""}
          </p>
        </details>
      )}
      <Danger note="Ends it as failed, against its holder.">
        <button type="button" className="btn danger" onClick={() => confirm({ action: "fail_job", params, title: `Mark job failed: ${j.title}` })}>
          Mark failed
        </button>
      </Danger>
    </div>
  );
}

export function AgentControls({ a }: { a: OpsAgent }) {
  const { confirm } = useApp();
  if (a.revoked_at) return null;
  return (
    <Danger note="Ends this credential. The preview lists what else it changes.">
      <button type="button" className="btn danger" onClick={() => confirm({ action: "revoke_agent", params: { name: a.name }, title: `Revoke agent ${a.name}` })}>
        Revoke
      </button>
    </Danger>
  );
}

export function JobBody({ j, onClose }: { j: OpsJob; onClose: () => void }) {
  const { now, feed } = useApp();
  const k = JOB[j.status];
  const prs = feed.live.prs.filter((p) => p.job_id === j.id);
  return (
    <>
      <Head label={`Job · ${j.namespace}`} title={j.title} sub={j.id} badge={<Pill kind={k.kind}>{k.label}</Pill>} onClose={onClose} />
      <div className="dbody">
        {j.status === "parked" && (
          <div>
            <p className="section-title">Parked until</p>
            <div className="callout">{j.parked_reason ?? "No reason was recorded."}</div>
          </div>
        )}
        {j.status === "blocked" && j.question && (
          <div>
            <p className="section-title">Asks you</p>
            <div className="callout warn" data-question="">
              {(j.waits_on ?? "No question was recorded.").replace(/^QUESTION:\s*/, "")}
            </div>
            <p className="faint small">Answer it with the button below: your reason and note go to its driver as the resume note.</p>
          </div>
        )}
        {j.status === "blocked" && !j.question && (
          <>
            <div>
              <p className="section-title">Waits on</p>
              <div className="callout warn">{j.waits_on ?? "No reason was recorded."}</div>
            </div>
            <div>
              <p className="section-title">Run this</p>
              {j.command_signature === "mismatch" ? (
                <div className="callout crit" data-signature="mismatch">
                  Withheld. This command's signature does not match, so it was changed after the block wrote it. Do not run anything from this job; tell the seat.
                </div>
              ) : j.command ? (
                <>
                  <CopyBlock id="cmdText" text={j.command} label="Copy command" />
                  {j.command_signature !== "verified" && (
                    <p className="faint small" data-signature={j.command_signature ?? "none"}>
                      {j.command_signature === "legacy-unsigned"
                        ? "Unsigned: written before blocks were signed, so nothing vouches that this is the command the driver wrote. Read it before running it."
                        : "The signature could not be checked on this Worker."}
                    </p>
                  )}
                </>
              ) : (
                <div className="faint">No command was recorded.</div>
              )}
            </div>
            <div>
              <p className="section-title">Or resume it from chat</p>
              <CopyBlock id="resumeText" text={resumeCall(j)} label="Copy for a chat session" />
              <p className="faint small">Resume it with the button below, or paste this into a chat session.</p>
            </div>
          </>
        )}
        <JobControls j={j} />
        <div>
          <p className="section-title">Record</p>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <St kind={k.kind}>{k.label}</St> <span className="faint">{jobMeta(j, now)}</span>
            </dd>
            <dt>Priority</dt>
            <dd className="num">{j.priority}</dd>
            <dt>Posted by</dt>
            <dd className="mono">{j.posted_by}</dd>
            <dt>Created</dt>
            <dd>
              {ago(ms(j.created_at), now)} <When t={ms(j.created_at)} />
            </dd>
            <dt>Last change</dt>
            <dd>
              {ago(ms(j.updated_at), now)} <When t={ms(j.updated_at)} />
            </dd>
            {j.claimed_by && (
              <>
                <dt>Held by</dt>
                <dd className="mono">{j.claimed_by}</dd>
              </>
            )}
            <dt>Blocked / resumed</dt>
            <dd className="num">
              {j.blocked_count} / {j.resumed_count}
            </dd>
            <dt>Gate required</dt>
            <dd>{j.gate_required ? "yes" : "no"}</dd>
            {j.finding && (
              <>
                <dt>Finding</dt>
                <dd className="mono">{j.finding.fingerprint}</dd>
                {j.finding.seen_count !== null && (
                  <>
                    <dt>Seen</dt>
                    <dd className="num">
                      {j.finding.seen_count} {j.finding.seen_count === 1 ? "time" : "times"}
                      {j.finding.last_seen ? `, last ${j.finding.last_seen}` : ""}
                    </dd>
                  </>
                )}
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
