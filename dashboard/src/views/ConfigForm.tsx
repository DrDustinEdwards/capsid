import { Alert } from "capsomer/react/banner";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import "capsomer/button.css";
import "capsomer/field.css";

// The one shell of the Portal's add and edit forms (sites, packages, projects): a panel that
// scrolls into view and focuses its first field when it opens, the fields, a hint when the
// draft is not yet sendable, Preview and Cancel, and an optional Danger area. Preview never
// changes anything: it opens the confirm dialog, which shows what the server will do.

/** The form's ids and its first field, which takes focus when the form opens. */
export function useConfigForm(): {
  f: (k: string) => string;
  first: RefObject<HTMLInputElement | null>;
} {
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  return { f: (k) => `${id}-${k}`, first };
}

export function ConfigForm({
  f,
  first,
  title,
  src,
  hint,
  onSubmit,
  onClose,
  danger,
  children,
}: {
  f: (k: string) => string;
  first: RefObject<HTMLInputElement | null>;
  title: string;
  src?: string;
  hint: string | null;
  onSubmit: () => void;
  onClose: () => void;
  danger?: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
    first.current?.focus();
  }, [first]);
  return (
    <section className="cap-panel" ref={box} aria-labelledby={f("h")}>
      <header className="cap-panel-head">
        <h2 id={f("h")}>{title}</h2>
        {src && <span className="cap-panel-src">{src}</span>}
      </header>
      <form
        className="siteform"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {children}
        {hint && (
          <div className="full">
            <Alert tone="warn">{hint}</Alert>
          </div>
        )}
        <div className="toolbar full">
          <button type="submit" className="cap-btn" data-variant="primary">
            Preview
          </button>
          <button type="button" className="cap-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
        {danger}
      </form>
    </section>
  );
}

export function Field({
  id,
  label,
  note,
  children,
}: {
  id: string;
  label: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="f">
      <label htmlFor={id} className="section-title">
        {label}
      </label>
      {children}
      {note && (
        <span id={`${id}-note`} className="faint note">
          {note}
        </span>
      )}
    </div>
  );
}
