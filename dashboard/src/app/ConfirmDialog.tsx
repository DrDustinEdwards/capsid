import { useEffect, useRef, useState } from "react";
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
import "capsomer/disclosure.css";
import { performAction, previewAction } from "../lib/api";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type { PortalPerformed, PortalPreview } from "../types";
import { DESTRUCTIVE, ONE_WAY, performLabel, type ConfirmRequest } from "./ctx";

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

export function ConfirmDialog({ req, csrf, onClose, onSignedOut }: DialogProps) {
  const { open, finish, onOpenChange, returnTo } = useClosing({ onClose, onSignedOut });
  const doIt = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);
  const step = useTwoStep({
    preview: (params: Record<string, string>) =>
      previewAction(csrf, { action: req.action, params }),
    perform: (shown: PortalPreview) => performAction(csrf, shown.token),
    onDone: (r: PortalPerformed) => finish(r),
    onSignedOut: () => finish("signed-out"),
  });
  const { preview, pending, error, runPerform } = step;
  const label = performLabel(req.action, req.params);
  const destructive = DESTRUCTIVE.has(req.action);

  const runPreview = () => step.runPreview(req.params);

  useEffect(() => {
    // Once, even under StrictMode's double effect.
    if (!started.current) {
      started.current = true;
      void runPreview();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount (the started ref guards StrictMode): the dialog asks for its preview as it opens
  }, []);

  useEffect(() => {
    if (preview) (ONE_WAY.has(req.action) ? cancelRef : doIt).current?.focus();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refocus when the preview arrives; a changed action does not move focus
  }, [preview]);

  const busy = step.busy;

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
  } else if (error) {
    primary = (
      <Button variant="primary" pending={pending === "preview"} onClick={() => void runPreview()}>
        {error.expired ? "Preview again" : "Try again"}
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
        {/* The server's summary can name a record by its id, so it sits under the plain heading once the preview answers. */}
        <DialogTitle>{req.title}</DialogTitle>
        {preview && <DialogDescription data-summary="">{preview.summary}</DialogDescription>}
      </DialogHeader>
      <DialogBody className="cap-stack" data-gap="4">
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
        {error && (
          <Alert
            title={
              error.expired
                ? "The confirmation expired. Preview again to get a new one."
                : undefined
            }
          >
            <span className="prewrap">{error.text}</span>
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
