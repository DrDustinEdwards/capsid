import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useApp, type UndoRequest } from "../app/ctx";
import { runAction } from "../lib/api";
import type { PortalActionRequest } from "../types";

// The switch pattern (APG Switch; capsid/research/ui-pattern-catalogue.md). Its name is
// fixed, given by label, and never changes with its state: the state is aria-checked,
// and the word On or Off beside the track is shown but not part of the name.
export function Switch({
  id,
  label,
  checked,
  busy,
  disabled,
  onClick,
  ref,
}: {
  id?: string;
  label: string;
  checked: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={ref} type="button" id={id} role="switch" className="switch" aria-checked={checked} aria-label={label} aria-busy={busy || undefined} disabled={disabled} onClick={onClick}>
      <span className="track" aria-hidden="true" />
      <span className="word" aria-hidden="true">
        {checked ? "On" : "Off"}
      </span>
    </button>
  );
}

// The one-line reason an automation change asks for, beside its control (the control
// pattern rule). Enter applies, Esc cancels. An empty reason is an error on the field and
// sends nothing; a refusal from the Worker is shown here in plain words and stays until
// the next try or Cancel. The field is disabled while the request runs.
export function ReasonForm({
  id,
  verb,
  onApply,
  onCancel,
  onBusy,
}: {
  id: string;
  // "Turning seat start off": the label reads "<verb>. Reason:".
  verb: string;
  // Resolves to null when the change applied, or the refusal to show.
  onApply: (reason: string) => Promise<string | null>;
  onCancel: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [empty, setEmpty] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  const setBusy = (b: boolean) => {
    setBusyState(b);
    onBusy?.(b);
  };
  const submit = async () => {
    if (busy) return;
    // Read from the field too, so a value filled in without an input event counts.
    const why = (input.current?.value ?? value).trim();
    if (!why) {
      setRefusal(null);
      setEmpty(true);
      input.current?.focus();
      return;
    }
    setEmpty(false);
    setRefusal(null);
    setBusy(true);
    let err: string | null;
    try {
      err = await onApply(why);
    } catch (e) {
      err = `The change could not be sent: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!alive.current) return;
    setBusy(false);
    if (err) {
      setRefusal(err);
      requestAnimationFrame(() => input.current?.focus());
    }
  };
  const errId = `${id}-err`;
  return (
    <form
      className="reason"
      aria-busy={busy || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Held while the request runs, so its answer is not hidden.
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <label htmlFor={id}>{verb}. Reason:</label>
      <input
        ref={input}
        id={id}
        className="field"
        autoComplete="off"
        value={value}
        disabled={busy}
        aria-invalid={empty || undefined}
        aria-describedby={empty ? `${errId} ${id}-hint` : `${id}-hint`}
        onChange={(e) => {
          setValue(e.target.value);
          if (empty && e.target.value.trim()) setEmpty(false);
        }}
      />
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? "Applying..." : "Apply"}
      </button>
      <button type="button" className="btn" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <span className="sr-only" id={`${id}-hint`}>
        Enter applies, Escape cancels. The reason is recorded with the change.
      </span>
      {empty && (
        <span className="err" id={errId} role="alert">
          Type a reason. It is recorded with the change.
        </span>
      )}
      {refusal && (
        <span className="err prewrap" role="alert">
          {refusal}
        </span>
      )}
    </form>
  );
}

// An automation switch: flipping it does not move it. It opens the reason field beside
// it, and the switch moves only when the change has applied (its state comes from the
// feed the perform returns). Focus goes back to the switch on apply and on cancel.
export function AutomationSwitch({
  id,
  label,
  checked,
  verb,
  onApply,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  verb: (next: boolean) => string;
  onApply: (next: boolean, reason: string) => Promise<string | null>;
  // Shown beside the switch while no reason is being asked for.
  children?: ReactNode;
}) {
  // The state the flip asks for, fixed when the field opens so a poll that lands
  // meanwhile cannot turn "off" into "on".
  const [next, setNext] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const sw = useRef<HTMLButtonElement>(null);
  const back = () => requestAnimationFrame(() => sw.current?.focus());
  const fieldId = `${id}-why`;
  return (
    <div className="autoctl">
      <Switch
        ref={sw}
        id={id}
        label={label}
        checked={checked}
        busy={busy}
        onClick={() => (next === null ? setNext(!checked) : document.getElementById(fieldId)?.focus())}
      />
      {next !== null ? (
        <ReasonForm
          id={fieldId}
          verb={verb(next)}
          onBusy={setBusy}
          onCancel={() => {
            setNext(null);
            back();
          }}
          onApply={async (why) => {
            const err = await onApply(next, why);
            if (!err) {
              setNext(null);
              back();
            }
            return err;
          }}
        />
      ) : (
        children
      )}
    </div>
  );
}

// Sends one switch change (preview, then perform, with no dialog: the applied reason is
// the confirmation) and, when it applies, hands the result and its Undo to the app's
// message. Resolves to null when it applied, or the refusal in plain words.
export function useApplySwitch(): (req: PortalActionRequest, undo: UndoRequest) => Promise<string | null> {
  const { feed, performed, signOut } = useApp();
  const csrf = feed.csrf;
  return useCallback(
    async (req, undo) => {
      const r = await runAction(csrf, req);
      if (r.kind === "ok") {
        performed(r.value, undo);
        return null;
      }
      if (r.kind === "signed-out") {
        signOut();
        return null;
      }
      if (r.kind === "error") return `Could not reach the server: ${r.message}`;
      return r.message;
    },
    [csrf, performed, signOut],
  );
}
