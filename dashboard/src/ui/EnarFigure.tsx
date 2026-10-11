import type { ReactNode } from "react";

// A bar, line or area chart from enarratio/lite (0.3.0). Those return the whole <figure>:
// the legend, the <svg role="img"> with its text alternative, and the data table. Like
// EnarChart (Enar.tsx), draw runs here so one chart's refusal, in Enarratio's own words,
// does not take the page down. Kept out of Enar.tsx, which is in the initial bundle: only
// the lazy chart chunk imports this.
export function EnarFigure({ draw, className, children }: { draw: () => string; className?: string; children?: ReactNode }) {
  let html: string;
  try {
    html = draw();
  } catch (err) {
    return <p className="faint enar-refused">This chart could not be drawn: {err instanceof Error ? err.message : String(err)}</p>;
  }
  return (
    <div className={`enar-fig${className ? ` ${className}` : ""}`}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {children}
    </div>
  );
}
