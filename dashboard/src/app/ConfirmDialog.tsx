import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Disclosure } from "capsomer/react/disclosure";
import { Field } from "capsomer/react/field";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/disclosure.css";
import "capsomer/field.css";
import { performAction, previewAction, type Answer } from "../lib/api";
import { ago, ms, utc } from "../lib/format";
import type { PortalPerformed, PortalPreview } from "../types";
import { DESTRUCTIVE, NEEDS_REASON, ONE_WAY, TAKES_NOTE, TYPED_CONFIRM, performLabel, type BatchItem, type ConfirmRequest } from "./ctx";

// The actions whose Details start open: a rule change's or a policy's added and removed
// lines are what the person is deciding.
const OPEN_DETAILS: ReadonlySet<string> = new Set(["sign_policy_from_repo"]);

// The one confirm dialog every control opens, on Capsomer's dialog. It collects a reason
// where the action needs one, previews (which writes nothing), shows what will change and
// the audit rows, and performs only on the button named for the action (performLabel).
// Cancel, Close and Esc close it; a click outside does not, so a typed reason is never lost
// that way. For a one-way action the preview puts focus on Cancel, not on perform (audit
// DECIDE 11).
interface DialogProps {
  req: ConfirmRequest;
  csrf: string;
  // Called once, with the result when the action was performed.
  onClose: (performed: PortalPerformed | null) => void;
  onSignedOut: () => void;
}

export function ConfirmDialog(props: DialogProps) {
  return props.req.batch ? <BatchDialog {...props} items={props.req.batch} /> : <SingleDialog {...props} />;
}

// Open until finish(), then closed by Capsomer's dialog, which hands focus back to the
// control that opened it, or, when that control is gone (a revoked agent loses its Revoke
// button), to the drawer or the page.
function useClosing({ onClose, onSignedOut }: Pick<DialogProps, "onClose" | "onSignedOut">) {
  const [open, setOpen] = useState(true);
  const result = useRef<PortalPerformed | null | "signed-out">(null);
  const closed = useRef(false);
  const [returnTo] = useState(() => document.querySelector<HTMLElement>("dialog.drawer[open] [data-close]") ?? document.querySelector<HTMLElement>("main"));
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
  const alive = useRef(true);
  const needsReason = NEEDS_REASON.has(req.action);
  // A reason typed before the dialog opened (the reply box on a Needs you row) is the
  // reason: the dialog previews with it at once and shows it, rather than asking again.
  const given = needsReason ? (req.params.reason ?? "").trim() : "";
  const askReason = needsReason && !given;
  const [reason, setReason] = useState("");
  const takesNote = TAKES_NOTE.has(req.action);
  const [note, setNote] = useState("");
  // The actions that widen autonomy ask for the version number typed before the preview, so
  // the token carries it; a wrong number is refused with the right one.
  const typesConfirm = TYPED_CONFIRM.has(req.action);
  const [typedVersion, setTypedVersion] = useState("");
  const [preview, setPreview] = useState<PortalPreview | null>(null);
  const [pending, setPending] = useState<null | "preview" | "perform">(null);
  // field: the error is about the reason or version field itself, so it is shown there.
  const [error, setError] = useState<{ text: string; expired: boolean; field?: boolean } | null>(null);
  const label = performLabel(req.action, req.params);
  const destructive = DESTRUCTIVE.has(req.action);

  const failed = (r: Exclude<Answer<unknown>, { kind: "ok" }>) => {
    if (r.kind === "signed-out") return finish("signed-out");
    if (r.kind === "expired") return setError({ text: r.message, expired: true });
    if (r.kind === "refused") return setError({ text: r.message, expired: false });
    setError({ text: `Could not reach the server: ${r.message}`, expired: false });
  };

  // Every click on Preview ends in something the person can see: the preview, a
  // refusal, a timeout, or the reason it could not be sent. A click that does nothing
  // is the defect this dialog was sent back for.
  const runPreview = async (why: string) => {
    const typed = needsReason ? given || why.trim() : "";
    if (needsReason && !typed) {
      setError({ text: "A reason is required. Type what you are doing and why, then preview.", expired: false, field: true });
      reasonRef.current?.focus();
      return;
    }
    const typedNote = takesNote ? (noteRef.current?.value ?? (note || req.params.note || "")).trim() : "";
    const version = typesConfirm ? (confirmRef.current?.value ?? typedVersion).trim() : "";
    if (typesConfirm && !version) {
      setError({ text: "Type the version number of the policy to be signed, then preview. The preview names it if you do not know it.", expired: false, field: true });
      confirmRef.current?.focus();
      return;
    }
    const params = { ...req.params, ...(needsReason ? { reason: typed } : {}), ...(typedNote ? { note: typedNote } : {}), ...(typesConfirm ? { confirm: version } : {}) };
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
    // Once, even under StrictMode's double effect: an action without a reason
    // previews as soon as the dialog opens.
    if (!started.current) {
      started.current = true;
      if (!askReason && !typesConfirm) void runPreview("");
    }
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (preview) (ONE_WAY.has(req.action) ? cancelRef : doIt).current?.focus();
  }, [preview]);

  const busy = pending != null;
  const fieldError = error?.field ? error.text : undefined;

  let primary = null;
  if (preview) {
    primary = (
      <Button ref={doIt} variant={destructive ? "danger" : "primary"} pending={pending === "perform"} onClick={() => void runPerform()}>
        {label}
      </Button>
    );
  } else if (askReason || typesConfirm || (error && !error.field)) {
    primary = (
      // A plain button with its own handler: Preview never depends on the form's submit
      // event, and it is held only while a request is in flight, never silently because
      // the reason is empty (that click says so instead).
      <Button variant="primary" pending={pending === "preview"} onClick={() => void runPreview(reasonNow())}>
        {error?.expired ? "Preview again" : error && !error.field ? "Try again" : "Preview"}
      </Button>
    );
  }

  return (
    <Dialog className="confirm" open={open} onOpenChange={onOpenChange} modalLock busy={busy} returnTo={returnTo} size="md">
      <DialogHeader>
        {/* The heading stays in plain words (req.title); the server's summary, which can
            name a job by its id, sits under it once the preview answers. */}
        <DialogTitle>{req.title}</DialogTitle>
        {preview && <DialogDescription data-summary="">{preview.summary}</DialogDescription>}
      </DialogHeader>
      <DialogBody className="stack-gap">
        {given && (
          <div>
            <p className="section-title">Your reply</p>
            <p className="note prewrap" data-given-reason="">
              {given}
            </p>
          </div>
        )}
        {typesConfirm && !askReason && !preview && (
          <form
            className="stack-gap"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void runPreview("");
            }}
          >
            <Field label="Version to sign" required help="The version number in the policy file. It decides what merges with no human, so it is typed, not clicked." error={fieldError} announce>
              <input ref={confirmRef} className="cap-input" type="text" inputMode="numeric" autoComplete="off" autoFocus value={typedVersion} readOnly={busy} onChange={(e) => setTypedVersion(e.target.value)} />
            </Field>
          </form>
        )}
        {askReason && !preview && (
          <form
            className="stack-gap"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) void runPreview(reasonNow());
            }}
          >
            <Field label="Reason" required help="Recorded with the change. Preview shows what will change before anything is written." error={fieldError} announce>
              <textarea
                ref={reasonRef}
                className="cap-input"
                rows={3}
                autoFocus
                value={reason}
                readOnly={busy}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  // Ctrl or Cmd with Enter previews; a plain Enter is a new line.
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
                    e.preventDefault();
                    void runPreview(reasonNow());
                  }
                }}
              />
            </Field>
            {takesNote && (
              <Field label="Note for the driver (optional)" help="The full approval, when a line is not enough. The driver reads it with the job on its next claim.">
                <textarea ref={noteRef} className="cap-input" rows={4} maxLength={16384} value={note} readOnly={busy} onChange={(e) => setNote(e.target.value)} />
              </Field>
            )}
          </form>
        )}
        {pending === "preview" && (
          <div className="faint" role="status">
            Checking what this will change...
          </div>
        )}
        {/* The sentence above is the answer; the rows it changes and the audit rows it
            writes are the server's own text, behind Details (the UX audit's M5). A rule
            change's lines are what is being decided, so they start open. */}
        {preview && (
          <Disclosure summary="Details" defaultOpen={OPEN_DETAILS.has(req.action)}>
            <div className="stack-gap">
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
            </div>
          </Disclosure>
        )}
        {error && !error.field && (
          <Alert title={error.expired ? "The confirmation expired. Preview again to get a new one." : undefined}>
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

// Several rows decided in one dialog (Needs you's batch approve). Each item is previewed on
// its own, as its single control would be, and the previews are listed together; perform
// sends each item's own token, one after another, and a refusal of one does not stop the
// rest. The result names what was done and, lasting, what was not.
function BatchDialog({ req, csrf, onClose, onSignedOut, items }: DialogProps & { items: ReadonlyArray<BatchItem> }) {
  const { open, finish, onOpenChange, returnTo } = useClosing({ onClose, onSignedOut });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);
  const finished = useRef(false);
  const alive = useRef(true);
  type Row = { item: BatchItem; preview: PortalPreview | null; error: string | null };
  const [rows, setRows] = useState<Row[]>(() => items.map((item) => ({ item, preview: null, error: null })));
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
      setRows([...next, ...items.slice(next.length).map((i) => ({ item: i, preview: null, error: null }))]);
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
    const warnings = [...ok.map((d) => d.warning).filter((w): w is string => w !== null), ...(failed.length ? [`${failed.length} not done: ${failed.join(" ")}`] : [])];
    done({ ...last, summary: ok.map((d) => d.summary).join(" "), warning: warnings.length ? warnings.join(" ") : null });
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
  }, []);

  // Every item here is one-way once performed together, so the preview leaves focus on Cancel.
  useEffect(() => {
    if (pending === null) cancelRef.current?.focus();
  }, [pending]);

  const busy = pending !== null;
  return (
    <Dialog className="confirm" open={open} onOpenChange={onOpenChange} modalLock busy={busy} returnTo={returnTo} size="md">
      <DialogHeader>
        <DialogTitle>{req.title}</DialogTitle>
      </DialogHeader>
      <DialogBody className="stack-gap">
        <ol className="plain batch-list">
          {rows.map((r) => (
            <li key={r.item.label} data-batch-item={r.item.label}>
              <b>{r.item.label}</b>
              {r.preview ? (
                <span className="muted note"> {r.preview.summary}</span>
              ) : r.error ? (
                <Alert>
                  <ErrorText>{r.error}</ErrorText>
                </Alert>
              ) : (
                <span className="faint"> Checking...</span>
              )}
            </li>
          ))}
        </ol>
        {pending === "preview" && (
          <div className="faint" role="status">
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
          <Button variant="primary" pending={pending === "perform"} onClick={() => void performAll()}>
            {`${label} ${ready.length}`}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
