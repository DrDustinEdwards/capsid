import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "capsomer/react/dialog";
import { useTwoStep } from "capsomer/react/confirm-dialog";
import { Disclosure } from "capsomer/react/disclosure";
import { Field } from "capsomer/react/field";
import "capsomer/disclosure.css";
import "capsomer/field.css";
import { performAction, previewAction } from "../lib/api";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type { PortalPerformed, PortalPreview } from "../types";
import {
  DESTRUCTIVE,
  NEEDS_REASON,
  ONE_WAY,
  TAKES_NOTE,
  performLabel,
  type ConfirmRequest,
} from "./ctx";

interface DialogProps {
  req: ConfirmRequest;
  csrf: string;
  onClose: (performed: PortalPerformed | null) => void;
  onSignedOut: () => void;
}

// Closed by Capsomer's dialog, which returns focus to the opener, or to the drawer or page when that control is gone (a revoked agent's Revoke button).
function useClosing({ onClose, onSignedOut }: Pick<DialogProps, "onClose" | "onSignedOut">) {
  const [open, setOpen] = useState(true);
  const result = useRef<PortalPerformed | null | "signed-out">(null);
  const closed = useRef(false);
  const [returnTo] = useState(
    () =>
      document.querySelector<HTMLElement>("dialog.drawer[open] [data-close]") ??
      document.querySelector<HTMLElement>("main"),
  );
  const finish = (r: PortalPerformed | null | "signed-out") => {
    result.current = r;
    setOpen(false);
  };
  const onOpenChange = (o: boolean) => {
    if (o || closed.current) return;
    closed.current = true;
    setOpen(false);
    const r = result.current;
    if (r === "signed-out") onSignedOut();
    else onClose(r);
  };
  return { open, finish, onOpenChange, returnTo };
}

function ErrorText({ children }: { children: ReactNode }) {
  return <span className="prewrap">{children}</span>;
}

export function ConfirmDialog({ req, csrf, onClose, onSignedOut }: DialogProps) {
  const { open, finish, onOpenChange, returnTo } = useClosing({ onClose, onSignedOut });
  const doIt = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);
  const needsReason = NEEDS_REASON.has(req.action);
  const given = needsReason ? (req.params.reason ?? "").trim() : "";
  const askReason = needsReason && !given;
  const [reason, setReason] = useState("");
  const takesNote = TAKES_NOTE.has(req.action);
  const [note, setNote] = useState("");
  const step = useTwoStep({
    preview: (params: Record<string, string>) =>
      previewAction(csrf, { action: req.action, params }),
    perform: (shown: PortalPreview) => performAction(csrf, shown.token),
    onDone: (r: PortalPerformed) => finish(r),
    onSignedOut: () => finish("signed-out"),
  });
  const { preview, pending, error, setError, runPerform } = step;
  const label = performLabel(req.action, req.params);
  const destructive = DESTRUCTIVE.has(req.action);

  const runPreview = async (why: string) => {
    const typed = needsReason ? given || why.trim() : "";
    if (needsReason && !typed) {
      setError({
        text: "A reason is required. Type what you are doing and why, then preview.",
        expired: false,
        field: true,
      });
      reasonRef.current?.focus();
      return;
    }
    const typedNote = takesNote
      ? (noteRef.current?.value ?? (note || req.params.note || "")).trim()
      : "";
    const params = {
      ...req.params,
      ...(needsReason ? { reason: typed } : {}),
      ...(typedNote ? { note: typedNote } : {}),
    };
    await step.runPreview(params);
  };

  // Read from the field too, so a value the browser filled in without an input event counts.
  const reasonNow = () => reasonRef.current?.value ?? reason;

  useEffect(() => {
    // Once, even under StrictMode's double effect.
    if (!started.current) {
      started.current = true;
      if (!askReason) void runPreview("");
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount (the started ref guards StrictMode): the dialog asks for its preview as it opens
  }, []);

  useEffect(() => {
    if (preview) (ONE_WAY.has(req.action) ? cancelRef : doIt).current?.focus();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refocus when the preview arrives; a changed action does not move focus
  }, [preview]);

  const busy = step.busy;
  const fieldError = error?.field ? error.text : undefined;

  let primary = null;
  if (preview) {
    primary = (
      <Button
        ref={doIt}
        variant={destructive ? "danger" : "primary"}
        pending={pending === "perform"}
        onClick={() => void runPerform()}
      >
        {label}
      </Button>
    );
  } else if (askReason || (error && !error.field)) {
    primary = (
      // Preview never depends on the form's submit event; it is held only while a request is in flight.
      <Button
        variant="primary"
        pending={pending === "preview"}
        onClick={() => void runPreview(reasonNow())}
      >
        {error?.expired ? "Preview again" : error && !error.field ? "Try again" : "Preview"}
      </Button>
    );
  }

  return (
    <Dialog
      className="confirm"
      open={open}
      onOpenChange={onOpenChange}
      modalLock
      busy={busy}
      returnTo={returnTo}
      size="md"
    >
      <DialogHeader>
        {/* The server's summary can name a job by its id, so it sits under the plain heading once the preview answers. */}
        <DialogTitle>{req.title}</DialogTitle>
        {preview && <DialogDescription data-summary="">{preview.summary}</DialogDescription>}
      </DialogHeader>
      <DialogBody className="cap-stack" data-gap="4">
        {given && (
          <div>
            <p className="section-title">Your reply</p>
            <p className="cap-text prewrap note" data-size="small" data-given-reason="">
              {given}
            </p>
          </div>
        )}
        {askReason && !preview && (
          <form
            className="cap-stack"
            data-gap="4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void runPreview(reasonNow());
            }}
          >
            <Field label="Reason" required error={fieldError} announce>
              <textarea
                ref={reasonRef}
                className="cap-input"
                rows={3}
                autoFocus
                value={reason}
                readOnly={busy}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
                    e.preventDefault();
                    void runPreview(reasonNow());
                  }
                }}
              />
            </Field>
            {takesNote && (
              <Field label="Note for the driver (optional)">
                <textarea
                  ref={noteRef}
                  className="cap-input"
                  rows={4}
                  maxLength={16384}
                  value={note}
                  readOnly={busy}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            )}
          </form>
        )}
        {pending === "preview" && (
          <div className="cap-text" data-tone="dim" role="status">
            Checking what this will change...
          </div>
        )}
        {preview && (
          <Disclosure summary="Details">
            <div className="cap-stack" data-gap="4">
              <div>
                <p className="section-title">What changes</p>
                {preview.changes.length ? (
                  <ul className="plain">
                    {preview.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="cap-text" data-tone="dim">
                    None.
                  </div>
                )}
              </div>
              <div>
                <p className="section-title">Audit rows it writes</p>
                {preview.audit.length ? (
                  <ul className="plain cap-mono">
                    {preview.audit.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="cap-text" data-tone="dim">
                    None.
                  </div>
                )}
              </div>
              <p className="cap-text note" data-tone="dim" data-size="small">
                This confirmation is good until {utc(parse(preview.expires_at))} (
                {ago(parse(preview.expires_at))}).
              </p>
            </div>
          </Disclosure>
        )}
        {error && !error.field && (
          <Alert
            title={
              error.expired
                ? "The confirmation expired. Preview again to get a new one."
                : undefined
            }
          >
            <ErrorText>{error.text}</ErrorText>
          </Alert>
        )}
      </DialogBody>
      {/* A destructive perform sits apart from Cancel, at the far end. */}
      <DialogFooter align={preview && destructive ? "between" : undefined}>
        <Button ref={cancelRef} onClick={() => !busy && finish(null)}>
          Cancel
        </Button>
        {primary}
      </DialogFooter>
    </Dialog>
  );
}
