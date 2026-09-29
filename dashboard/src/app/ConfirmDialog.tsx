import { useEffect, useRef, useState } from "react";
import { performAction, previewAction, type Answer } from "../lib/api";
import { ago, ms, utc } from "../lib/format";
import type { PortalPerformed, PortalPreview } from "../types";
import { NEEDS_REASON, type ConfirmRequest } from "./ctx";

// The one confirm dialog every control opens. It collects a reason where the action
// needs one, previews (which writes nothing), shows what will change and the audit
// rows, and performs only on "Do it". Cancel sends nothing further.
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
  const opener = useRef<Element | null>(null);
  const started = useRef(false);
  const finished = useRef(false);
  const alive = useRef(true);
  const needsReason = NEEDS_REASON.has(req.action);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PortalPreview | null>(null);
  const [pending, setPending] = useState<null | "preview" | "perform">(null);
  const [error, setError] = useState<{ text: string; expired: boolean } | null>(null);

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
      const back = from instanceof HTMLElement && from.isConnected ? from : (document.querySelector<HTMLElement>(".drawer.on [data-close]") ?? document.querySelector<HTMLElement>("main"));
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

  const runPreview = async (why: string) => {
    const params = needsReason ? { ...req.params, reason: why.trim() } : req.params;
    setPending("preview");
    setError(null);
    setPreview(null);
    const r = await previewAction(csrf, { action: req.action, params });
    if (!alive.current) return;
    setPending(null);
    if (r.kind === "ok") setPreview(r.value);
    else failed(r);
  };

  const runPerform = async () => {
    if (!preview) return;
    setPending("perform");
    setError(null);
    const r = await performAction(csrf, preview.token);
    if (!alive.current) return;
    setPending(null);
    if (r.kind === "ok") return finish(r.value);
    if (r.kind === "expired") setPreview(null);
    failed(r);
  };

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
    if (preview) doIt.current?.focus();
  }, [preview]);

  const busy = pending != null;
  const canPreview = !needsReason || reason.trim().length > 0;

  let primary = null;
  if (preview) {
    primary = (
      <button ref={doIt} type="button" className="btn primary" disabled={busy} onClick={() => void runPerform()}>
        {pending === "perform" ? "Doing it..." : "Do it"}
      </button>
    );
  } else if (needsReason || error) {
    primary = (
      <button type={needsReason ? "submit" : "button"} form={needsReason ? "confirmForm" : undefined} className="btn primary" disabled={busy || !canPreview} onClick={needsReason ? undefined : () => void runPreview(reason)}>
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
      onClick={(e) => e.target === dlg.current && !busy && finish(null)}
    >
      <div className="card">
        <h2 id="confirmTitle">{preview ? preview.summary : req.title}</h2>
        {needsReason && !preview && (
          <form
            id="confirmForm"
            className="stack-gap"
            onSubmit={(e) => {
              e.preventDefault();
              if (canPreview && !busy) void runPreview(reason);
            }}
          >
            <label htmlFor="confirmReason" className="section-title">
              Reason (required)
            </label>
            <textarea id="confirmReason" rows={3} required autoFocus value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
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
          <div className="callout crit" role="alert">
            {error.expired && <b>The confirmation expired. Preview again to get a new one. </b>}
            <span className="prewrap">{error.text}</span>
          </div>
        )}
        <div className="toolbar">
          {primary}
          <button type="button" className="btn" disabled={busy} onClick={() => finish(null)}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
