import { Alert } from "capsomer/react/banner";
import { AwayLink } from "capsomer/react/link";
import type { ReactNode } from "react";
import { CopyButton } from "capsomer/react/copy";
import { KIND_STATUS, jobBadge, resumeCall } from "../lib/derive";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { OpsJob, OpsAgent } from "../types";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { DangerZone } from "capsomer/react/danger-zone";
import "capsomer/danger-zone.css";
import { jobMeta } from "../views/shared";
import { useApp, type ConfirmRequest } from "./ctx";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

export function Head({
  label,
  title,
  sub,
  badge,
  onClose,
}: {
  label: string;
  title: string;
  sub: string;
  badge?: ReactNode;
  onClose: () => void;
}) {
  return (
    <>
      <header className="cap-dialog-header" data-divider>
        <div className="cap-detail-heading">
          <p className="cap-detail-kind">{label}</p>
          <div className="cap-detail-titlerow">
            <h2 className="cap-dialog-title" id="drawerTitle">
              {title}
            </h2>
            {badge}
          </div>
          <p className="cap-detail-id">{sub}</p>
        </div>
      </header>
      <button
        type="button"
        className="cap-btn cap-dialog-close"
        data-variant="quiet"
        data-icon-only
        data-close
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
    </>
  );
}

function CopyBlock({ id, text, label }: { id: string; text: string; label: string }) {
  return (
    <div className="cap-stack" data-gap="3">
      <div className="cap-detail-cmd" id={id}>
        {text}
      </div>
      <CopyButton text={text} variant="default">
        {label}
      </CopyButton>
    </div>
  );
}

// Whether supersede may end the job: a queued one, or a claimed one with no work
// recorded yet (src/jobs-seat.ts, supersedeJob). The Worker checks again.
function supersedable(j: OpsJob): boolean {
  if (j.status === "queued") return true;
  return (
    j.status === "claimed" &&
    j.blocked_count === 0 &&
    j.resumed_count === 0 &&
    j.result_ref === null
  );
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
        <div className="cap-cluster" data-gap="3">
          <button
            type="button"
            className="cap-btn"
            data-variant="primary"
            onClick={() =>
              confirm({
                action: "unpark_job",
                params,
                title: `Unpark job: ${j.title}`,
                undo: {
                  action: "park_job",
                  params: {
                    id: j.id,
                    reason: j.parked_reason ?? "parked again",
                    undo: "true",
                  },
                },
              })
            }
          >
            Unpark
          </button>
        </div>
        <p className="cap-text hint" data-tone="dim" data-size="small">
          Unpark puts it back in the queue at its priority. The result offers Undo.
        </p>
      </div>
    );
  }
  const failable = blocked || claimed || queued;
  if (!failable) return null;
  // One primary action for the state the job is in, the other safe ones under More
  // actions, and Mark failed alone in the Danger area (the UX audit's M9: it sat beside
  // Close as shipped and Resume in a row of up to six).
  const resume = {
    action: "resume_job" as const,
    params,
    title: `${j.question ? "Answer" : "Resume job"}: ${j.title}`,
  };
  const release = {
    action: "release_job" as const,
    params,
    title: `Release job: ${j.title}`,
  };
  const park = {
    action: "park_job" as const,
    params,
    title: `Park job: ${j.title}`,
    undo: { action: "unpark_job" as const, params: { id: j.id, undo: "true" } },
  };
  const primary = blocked
    ? { req: resume, label: j.question ? "Answer" : "Resume" }
    : claimed
      ? { req: release, label: "Release" }
      : { req: park, label: "Park" };
  const more: Array<{ label: string; req: ConfirmRequest }> = [
    ...(blocked
      ? [
          {
            label: "Close as shipped",
            req: {
              action: "close_shipped" as const,
              params,
              title: `Close as shipped: ${j.title}`,
            },
          },
        ]
      : []),
    ...(supersedable(j)
      ? [
          {
            label: "Supersede",
            req: {
              action: "supersede_job" as const,
              params,
              title: `Supersede job: ${j.title}`,
            },
          },
        ]
      : []),
  ];
  return (
    <div className="cap-stack" data-gap="4" data-job-controls="">
      <div>
        <p className="section-title">Change it</p>
        <div className="cap-cluster" data-gap="3">
          <button
            type="button"
            className="cap-btn"
            data-variant="primary"
            onClick={() => confirm(primary.req)}
          >
            {primary.label}
          </button>
        </div>
        <p className="cap-text hint" data-tone="dim" data-size="small">
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
          <summary className="cap-btn">
            <span className="chev" aria-hidden="true" />
            More actions
          </summary>
          <div className="cap-cluster" data-gap="3">
            {more.map((m) => (
              <button
                key={m.label}
                type="button"
                className="cap-btn"
                onClick={() => confirm(m.req)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="cap-text hint" data-tone="dim" data-size="small">
            {blocked
              ? "Close as shipped ends it as done when its work already landed, credited to the driver. "
              : ""}
            {supersedable(j)
              ? "Supersede ends a job replaced before any work was done, with no outcome against anybody."
              : ""}
          </p>
        </details>
      )}
      <DangerZone note="Ends it as failed, against its holder.">
        <button
          type="button"
          className="cap-btn"
          data-variant="danger"
          onClick={() =>
            confirm({
              action: "fail_job",
              params,
              title: `Mark job failed: ${j.title}`,
            })
          }
        >
          Mark failed
        </button>
      </DangerZone>
    </div>
  );
}

export function AgentControls({ a }: { a: OpsAgent }) {
  const { confirm } = useApp();
  if (a.revoked_at) return null;
  return (
    <DangerZone note="Ends this credential. The preview lists what else it changes.">
      <button
        type="button"
        className="cap-btn"
        data-variant="danger"
        onClick={() =>
          confirm({
            action: "revoke_agent",
            params: { name: a.name },
            title: `Revoke agent ${a.name}`,
          })
        }
      >
        Revoke
      </button>
    </DangerZone>
  );
}

export function JobBody({ j, onClose }: { j: OpsJob; onClose: () => void }) {
  const { now, feed } = useApp();
  const k = jobBadge(j, now);
  const prs = feed.live.prs.filter((p) => p.job_id === j.id);
  return (
    <>
      <Head
        label={`Job · ${j.namespace}`}
        title={j.title}
        sub={j.id}
        badge={<Pill {...KIND_STATUS[k.kind]}>{k.label}</Pill>}
        onClose={onClose}
      />
      <div className="cap-dialog-body cap-detail-body">
        {j.status === "parked" && (
          <div>
            <p className="section-title">Parked until</p>
            <Alert tone="neutral">{j.parked_reason ?? "No reason was recorded."}</Alert>
          </div>
        )}
        {j.status === "blocked" && j.question && (
          <div>
            <p className="section-title">Asks you</p>
            <Alert tone="warn">
              {(j.waits_on ?? "No question was recorded.").replace(/^QUESTION:\s*/, "")}
            </Alert>
            <p className="cap-text hint" data-tone="dim" data-size="small">
              Answer it with the button below: your reason and note go to its driver as the resume
              note.
            </p>
          </div>
        )}
        {j.status === "blocked" && !j.question && (
          <>
            <div>
              <p className="section-title">Waits on</p>
              <Alert tone="warn">{j.waits_on ?? "No reason was recorded."}</Alert>
            </div>
            <div>
              <p className="section-title">Run this</p>
              {j.command_signature === "mismatch" ? (
                <div data-signature="mismatch">
                  <Alert tone="crit">
                    Withheld. This command's signature does not match, so it was changed after the
                    block wrote it. Do not run anything from this job; tell the seat.
                  </Alert>
                </div>
              ) : j.command ? (
                <>
                  <CopyBlock id="cmdText" text={j.command} label="Copy command" />
                  {j.command_signature !== "verified" && (
                    <p
                      className="cap-text hint"
                      data-tone="dim"
                      data-size="small"
                      data-signature={j.command_signature ?? "none"}
                    >
                      {j.command_signature === "legacy-unsigned"
                        ? "Unsigned: written before blocks were signed, so nothing vouches that this is the command the driver wrote. Read it before running it."
                        : "The signature could not be checked on this Worker."}
                    </p>
                  )}
                </>
              ) : (
                <div className="cap-text" data-tone="dim">
                  No command was recorded.
                </div>
              )}
            </div>
            <div>
              <p className="section-title">Or resume it from chat</p>
              <CopyBlock id="resumeText" text={resumeCall(j)} label="Copy for a chat session" />
              <p className="cap-text hint" data-tone="dim" data-size="small">
                Resume it with the button below, or paste this into a chat session.
              </p>
            </div>
          </>
        )}
        <JobControls j={j} />
        <div>
          <p className="section-title">Record</p>
          <dl className="cap-detail-record">
            <dt>Status</dt>
            <dd>
              <Status {...KIND_STATUS[k.kind]}>{k.label}</Status>{" "}
              <span className="cap-text" data-tone="dim">
                {jobMeta(j, now)}
              </span>
            </dd>
            <dt>Priority</dt>
            <dd className="cap-num">{j.priority}</dd>
            <dt>Posted by</dt>
            <dd className="cap-mono">{j.posted_by}</dd>
            <dt>Created</dt>
            <dd>
              {ago(parse(j.created_at), now)} <Time at={j.created_at} format="exact" />
            </dd>
            <dt>Last change</dt>
            <dd>
              {ago(parse(j.updated_at), now)} <Time at={j.updated_at} format="exact" />
            </dd>
            {j.claimed_by && (
              <>
                <dt>Held by</dt>
                <dd className="cap-mono">{j.claimed_by}</dd>
              </>
            )}
            <dt>Blocked / resumed</dt>
            <dd className="cap-num">
              {j.blocked_count} / {j.resumed_count}
            </dd>
            <dt>Gate required</dt>
            <dd>{j.gate_required ? "yes" : "no"}</dd>
            {j.finding && (
              <>
                <dt>Finding</dt>
                <dd className="cap-mono">{j.finding.fingerprint}</dd>
                {j.finding.seen_count !== null && (
                  <>
                    <dt>Seen</dt>
                    <dd className="cap-num">
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
                <dd className="cap-mono">
                  {/^https?:\/\//.test(j.result_ref) ? (
                    <AwayLink href={j.result_ref} newTab>
                      {j.result_ref}
                    </AwayLink>
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
        <AwayLink href={url} newTab>
          {url.replace(/^https:\/\/github\.com\//, "")}
        </AwayLink>{" "}
        <span className="cap-text" data-tone="dim">
          {merged === true ? "merged" : merged === false ? "not merged" : "open"}
        </span>
      </dd>
    </>
  );
}
