import { Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "../app/ErrorBoundary";

// An Enarratio primitive in the page (capsid/decisions.md 2026-10-09, Portal review item 7:
// "Enarratio in the browser for the Portal's charts", option a of
// capsid/research/enarratio-coverage.md). Enarratio returns markup as a string: an <svg>
// with role="img", its own text alternative and a <title> per mark, built with its
// escapeHtml from the values passed in, and no inline style or script, so it passes the
// page's CSP. The companion table states the same numbers as text (conventions 7.6).
// Colours come from the --enarratio-* variables styles.css maps to the Portal's tokens.

// draw runs here, not in the caller: Enarratio refuses input it cannot draw honestly (no
// value at all, say) by throwing, and one chart's refusal must not take the page down.
// The refusal is shown in the chart's place, in Enarratio's own words.
export function EnarChart({ draw, className, children }: { draw: () => { svg: string; table?: string }; className?: string; children?: ReactNode }) {
  let out: { svg: string; table?: string };
  try {
    out = draw();
  } catch (err) {
    return <p className="faint enar-refused">This chart could not be drawn: {err instanceof Error ? err.message : String(err)}</p>;
  }
  return (
    <figure className={`enar${className ? ` ${className}` : ""}`}>
      <div className="enar-mark" dangerouslySetInnerHTML={{ __html: out.svg }} />
      {children}
      {out.table && <div className="enar-table" dangerouslySetInnerHTML={{ __html: out.table }} />}
    </figure>
  );
}

// A lazy chart's place: nothing while its chunk loads, and a small message, not a blank
// Portal, when the chunk fails to load or the chart fails to render.
export function ChartSlot({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallback={<p className="faint enar-refused">This chart could not be loaded. Reload the page to try again.</p>}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
