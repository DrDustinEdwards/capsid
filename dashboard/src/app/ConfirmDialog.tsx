import { useEffect, useRef, useState } from "react";
import { performAction, previewAction, type Answer } from "../lib/api";
import { ago, ms, utc } from "../lib/format";
import type { PortalPerformed, PortalPreview } from "../types";
import { DESTRUCTIVE, NEEDS_REASON, ONE_WAY, performLabel, type ConfirmRequest } from "./ctx";

// The one confirm dialog every control opens. It collects a reason where the action
// needs one, previews (which writes nothing), shows what will change and the audit
// rows, and performs only on the button named for the action (performLabel). Cancel and
// Esc close it; a click outside does not, so a typed reason is never lost that way. For
// a one-way action the preview puts focus on Cancel, not on perform (audit DECIDE 11).
export function ConfirmDialog({
  req,
  csrf,
  onClose,
  onSignedOut,
}: {
  req: ConfirmRequest;
  csrf: string;
  // Called once, with the result when the action was performed.
  onClose: (performed: PortalPerformed | null) => void;
  onSignedOut: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const doIt = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<Element | null>(null);
  const started = useRef(false);
  const finished = useRef(false);
  const alive = useRef(true);
  const needsReason = NEEDS_REASON.has(req.action);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PortalPreview | null>(null);
  const [pending, setPending] = useState<null | "preview" | "perform">(null);
  // field: the error is about the reason field itself, so the field is marked invalid.
  const [error, setError] = useState<{ text: string; expired: boolean; field?: boolean } | null>(null);
  const label = performLabel(req.action, req.params);
  const destructive = DESTRUCTIVE.has(req.action);

  const finish = (performed: PortalPerformed | null) => {
    if (finished.current) return;
    finished.current = true;
    const d = dlg.current;
    if (d?.open) d.close();
    const from = opener.current;
    onClose(performed);
    // Hand focus back to the control that opened the dialog, or, when that control is
    // gone (a revoked agent loses its Revoke button), to the drawer or the page. After
    // the next frame, so the new feed has rendered first.
    requestAnimationFrame(() => {
      const back = from instanceof HTMLElement && from.isConnected ? from : (document.querySelector<HTMLElement>("dialog.drawer[open] [data-close]") ?? document.querySelector<HTMLElement>("main"));
      back?.focus();
    });
  };

  const failed = (r: Exclude<Answer<unknown>, { kind: "ok" }>) => {
    if (r.kind === "signed-out") {
      finished.current = true;
      if (dlg.current?.open) dlg.current.close();
      return onSignedOut();
    }
    if (r.kind === "expired") return setError({ text: r.message, expired: true });
    if (r.kind === "refused") return setError({ text: r.message, expired: false });
    setError({ text: `Could not reach the server: ${r.message}`, expired: false });
  };

  // Every click on Preview ends in something the person can see: the preview, a
  // refusal, a timeout, or the reason it could not be sent. A click that does nothing
  // is the defect this dialog was sent back for.
  const runPreview = async (why: string) => {
    const typed = needsReason ? why.trim() : "";
    if (needsReason && !typed) {
      setError({ text: "A reason is required. Type what you are doing and why, then preview.", expired: false, field: true });
      reasonRef.current?.focus();
      return;
    }
    const params = needsReason ? { ...req.params, reason: typed } : req.params;
    setPending("preview");
    setError(null);
    setPreview(null);
    try {
      const r = await previewAction(csrf, { action: req.action, params });
      if (!alive.current) return;
      if (r.kind === "ok") setPreview(r.value);
      else failed(r);
    } catch (e) {
      if (alive.current) setError({ text: `The preview could not be shown: ${e instanceof Error ? e.message : String(e)}`, expired: false });
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const runPerform = async () => {
    if (!preview) return;
    setPending("perform");
    setError(null);
    try {
      const r = await performAction(csrf, preview.token);
      if (!alive.current) return;
      if (r.kind === "ok") return finish(r.value);
      if (r.kind === "expired") setPreview(null);
      failed(r);
    } catch (e) {
      if (alive.current) setError({ text: `The result could not be shown: ${e instanceof Error ? e.message : String(e)}. Check Activity before trying again.`, expired: false });
    } finally {
      if (alive.current) setPending(null);
    }
  };

  // The reason is read from the field itself as well as from state, so a value the
  // browser filled in without an input event still counts.
  const reasonNow = () => reasonRef.current?.value ?? reason;

  useEffect(() => {
    alive.current = true;
    const d = dlg.current;
    if (d && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    }
    // Once, even under StrictMode's double effect: an action without a reason
    // previews as soon as the dialog opens.
    if (!started.current) {
      started.current = true;
      if (!needsReason) void runPreview("");
    }
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (preview) (ONE_WAY.has(req.action) ? cancelRef : doIt).current?.focus();
  }, [preview]);

  const busy = pending != null;

  let primary = null;
  if (preview) {
    primary = (
      <button ref={doIt} type="button" className={destructive ? "btn danger ml-auto" : "btn primary"} disabled={busy} onClick={() => void runPerform()}>
        {pending === "perform" ? "Working..." : label}
      </button>
    );
  } else if (needsReason || error) {
    primary = (
      // A plain button with its own handler: Preview never depends on the form's submit
      // event, and it is disabled only while a request is in flight, never silently
      // because the reason is empty (that click says so instead).
      <button type="button" className="btn primary" disabled={busy} onClick={() => void runPreview(reasonNow())}>
        {pending === "preview" ? "Checking..." : error?.expired ? "Preview again" : error ? "Try again" : "Preview"}
      </button>
    );
  }

  return (
    <dialog
      ref={dlg}
      className="help confirm"
      aria-labelledby="confirmTitle"
      aria-busy={busy}
      onCancel={(e) => {
        // Esc while a request is in flight would hide its answer.
        if (busy) e.preventDefault();
      }}
      onClose={() => finish(null)}
    >
      <div className="card">
        {/* The heading stays in plain words (req.title); the server's summary, which can
            name a job by its id, sits under it once the preview answers. */}
        <h2 id="confirmTitle">{req.title}</h2>
        {preview && <p className="muted note" data-summary="">{preview.summary}</p>}
        {needsReason && !preview && (
          <form
            id="confirmForm"
            className="stack-gap"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void runPreview(reasonNow());
            }}
          >
            <label htmlFor="confirmReason" className="section-title">
              Reason (required)
            </label>
            <textarea
              ref={reasonRef}
              id="confirmReason"
              rows={3}
              autoFocus
              value={reason}
              disabled={busy}
              aria-invalid={error?.field ? true : undefined}
              aria-describedby={error?.field ? "confirmError" : undefined}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl or Cmd with Enter previews; a plain Enter is a new line.
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
                  e.preventDefault();
                  void runPreview(reasonNow());
                }
              }}
            />
            <p className="faint note">Recorded with the change. Preview shows what will change before anything is written.</p>
          </form>
        )}
        {pending === "preview" && (
          <div className="faint" role="status">
            Checking what this will change...
          </div>
        )}
        {preview && (
          <>
            <div>
              <p className="section-title">What changes</p>
              {preview.changes.length ? (
                <ul className="plain">
                  {preview.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              ) : (
                <div className="faint">The server lists no change.</div>
              )}
            </div>
            <div>
              <p className="section-title">Audit rows it writes</p>
              {preview.audit.length ? (
                <ul className="plain mono">
                  {preview.audit.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              ) : (
                <div className="faint">The server lists no audit row.</div>
              )}
            </div>
            <p className="faint note">
              This confirmation is good until {utc(ms(preview.expires_at))} ({ago(ms(preview.expires_at))}).
            </p>
          </>
        )}
        {error && (
          <div className="callout crit" role="alert" id="confirmError">
            {error.expired && <b>The confirmation expired. Preview again to get a new one. </b>}
            <span className="prewrap">{error.text}</span>
          </div>
        )}
        {/* A destructive perform sits apart from Cancel, at the far end, after it. */}
        <div className="toolbar">
          {!(preview && destructive) && primary}
          <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={() => finish(null)}>
            Cancel
          </button>
          {preview && destructive && primary}
        </div>
      </div>
    </dialog>
  );
}
