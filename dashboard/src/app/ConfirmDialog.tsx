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
import { type Answer } from "capsomer/react/data";
import { ago } from "../lib/format";
import { parse, utc } from "capsomer/behavior/time";
import type { PortalPerformed, PortalPreview } from "../types";
import {
  DESTRUCTIVE,
  NEEDS_REASON,
  ONE_WAY,
  TAKES_NOTE,
  TYPED_CONFIRM,
  performLabel,
  type BatchItem,
  type ConfirmRequest,
} from "./ctx";

const OPEN_DETAILS: ReadonlySet<string> = new Set(["sign_policy_from_repo"]);

interface DialogProps {
  req: ConfirmRequest;
  csrf: string;
  onClose: (performed: PortalPerformed | null) => void;
  onSignedOut: () => void;
}

export function ConfirmDialog(props: DialogProps) {
  return props.req.batch ? (
    <BatchDialog {...props} items={props.req.batch} />
  ) : (
    <SingleDialog {...props} />
  );
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

function SingleDialog({ req, csrf, onClose, onSignedOut }: DialogProps) {
  const { open, finish, onOpenChange, returnTo } = useClosing({ onClose, onSignedOut });
  const doIt = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const needsReason = NEEDS_REASON.has(req.action);
  const given = needsReason ? (req.params.reason ?? "").trim() : "";
  const askReason = needsReason && !given;
  const [reason, setReason] = useState("");
  const takesNote = TAKES_NOTE.has(req.action);
  const [note, setNote] = useState("");
  const typesConfirm = TYPED_CONFIRM.has(req.action);
  const [typedVersion, setTypedVersion] = useState("");
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
    const version = typesConfirm ? (confirmRef.current?.value ?? typedVersion).trim() : "";
    if (typesConfirm && !version) {
      setError({
        text: "Type the version number of the policy to be signed, then preview. The preview names it if you do not know it.",
        expired: false,
        field: true,
      });
      confirmRef.current?.focus();
      return;
    }
    const params = {
      ...req.params,
      ...(needsReason ? { reason: typed } : {}),
      ...(typedNote ? { note: typedNote } : {}),
      ...(typesConfirm ? { confirm: version } : {}),
    };
    await step.runPreview(params);
  };

  // Read from the field too, so a value the browser filled in without an input event counts.
  const reasonNow = () => reasonRef.current?.value ?? reason;

  useEffect(() => {
    // Once, even under StrictMode's double effect.
    if (!started.current) {
      started.current = true;
      if (!askReason && !typesConfirm) void runPreview("");
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
  } else if (askReason || typesConfirm || (error && !error.field)) {
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
        {typesConfirm && !askReason && !preview && (
          <form
            className="cap-stack"
            data-gap="4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void runPreview("");
            }}
          >
            <Field
              label="Version to sign"
              required
              help={
                req.confirmHelp ??
                "The version number in the policy file. It decides what merges with no human, so it is typed, not clicked."
              }
              error={fieldError}
              announce
            >
              <input
                ref={confirmRef}
                className="cap-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={typedVersion}
                readOnly={busy}
                onChange={(e) => setTypedVersion(e.target.value)}
              />
            </Field>
          </form>
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
          <Disclosure summary="Details" defaultOpen={OPEN_DETAILS.has(req.action)}>
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

function BatchDialog({
  req,
  csrf,
  onClose,
  onSignedOut,
  items,
}: DialogProps & { items: ReadonlyArray<BatchItem> }) {
  const { open, finish, onOpenChange, returnTo } = useClosing({ onClose, onSignedOut });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);
  const finished = useRef(false);
  const alive = useRef(true);
  type Row = { item: BatchItem; preview: PortalPreview | null; error: string | null };
  const [rows, setRows] = useState<Row[]>(() =>
    items.map((item) => ({ item, preview: null, error: null })),
  );
  const [pending, setPending] = useState<null | "preview" | "perform">("preview");
  const [error, setError] = useState<string | null>(null);
  const ready = rows.filter((r) => r.preview);
  const first = items[0];
  const label = first ? performLabel(first.action, first.params) : "Go";

  const done = (r: PortalPerformed | null | "signed-out") => {
    finished.current = true;
    finish(r);
  };
  const words = (r: Exclude<Answer<unknown>, { kind: "ok" }>): string | null => {
    if (r.kind === "signed-out") {
      done("signed-out");
      return null;
    }
    return r.kind === "error" ? `Could not reach the server: ${r.message}` : r.message;
  };

  const previewAll = async () => {
    setPending("preview");
    setError(null);
    const next: Row[] = [];
    for (const item of items) {
      const r = await previewAction(csrf, { action: item.action, params: item.params });
      if (!alive.current || finished.current) return;
      if (r.kind === "ok") next.push({ item, preview: r.value, error: null });
      else {
        const w = words(r);
        if (w === null) return;
        next.push({ item, preview: null, error: w });
      }
      setRows([
        ...next,
        ...items.slice(next.length).map((i) => ({ item: i, preview: null, error: null })),
      ]);
    }
    setPending(null);
  };

  const performAll = async () => {
    setPending("perform");
    setError(null);
    const ok: PortalPerformed[] = [];
    const failed: string[] = [];
    for (const r of rows) {
      if (!r.preview) {
        if (r.error) failed.push(`${r.item.label}: ${r.error}`);
        continue;
      }
      const a = await performAction(csrf, r.preview.token);
      if (!alive.current) return;
      if (a.kind === "ok") ok.push(a.value);
      else {
        const w = words(a);
        if (w === null) return;
        failed.push(`${r.item.label}: ${w}`);
      }
    }
    setPending(null);
    const last = ok[ok.length - 1];
    if (!last) return setError(`Nothing was done. ${failed.join(" ")}`);
    const warnings = [
      ...ok.map((d) => d.warning).filter((w): w is string => w !== null),
      ...(failed.length ? [`${failed.length} not done: ${failed.join(" ")}`] : []),
    ];
    done({
      ...last,
      summary: ok.map((d) => d.summary).join(" "),
      warning: warnings.length ? warnings.join(" ") : null,
    });
  };

  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      void previewAll();
    }
    return () => {
      alive.current = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount (the started ref guards StrictMode): the dialog asks for its preview as it opens; a dependency would preview again
  }, []);

  // One-way once performed together, so the preview leaves focus on Cancel.
  useEffect(() => {
    if (pending === null) cancelRef.current?.focus();
  }, [pending]);

  const busy = pending !== null;
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
        <DialogTitle>{req.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="cap-stack" data-gap="4">
        <ol className="plain batch-list">
          {rows.map((r) => (
            <li key={r.item.label} data-batch-item={r.item.label}>
              <b>{r.item.label}</b>
              {r.preview ? (
                <span className="cap-text note" data-tone="muted" data-size="small">
                  {" "}
                  {r.preview.summary}
                </span>
              ) : r.error ? (
                <Alert>
                  <ErrorText>{r.error}</ErrorText>
                </Alert>
              ) : (
                <span className="cap-text" data-tone="dim">
                  {" "}
                  Checking...
                </span>
              )}
            </li>
          ))}
        </ol>
        {pending === "preview" && (
          <div className="cap-text" data-tone="dim" role="status">
            Checking what each one will change...
          </div>
        )}
        {error && (
          <Alert>
            <ErrorText>{error}</ErrorText>
          </Alert>
        )}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancelRef} onClick={() => !busy && finish(null)}>
          Cancel
        </Button>
        {pending !== "preview" && ready.length > 0 && (
          <Button
            variant="primary"
            pending={pending === "perform"}
            onClick={() => void performAll()}
          >
            {`${label} ${ready.length}`}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
