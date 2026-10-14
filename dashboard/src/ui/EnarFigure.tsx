import type { ReactNode } from "react";
import { FALLBACK_W } from "./Enar";
import { useWidth } from "./useWidth";

// A bar, line or area chart from enarratio/lite (0.3.0). Those return the whole <figure>:
// the legend, the <svg role="img"> with its text alternative, and the data table. Like
// EnarChart (Enar.tsx), draw runs here so one chart's refusal, in Enarratio's own words,
// does not take the page down. Kept out of Enar.tsx, which is in the initial bundle: only
// the lazy chart chunk imports this.
// draw gets the figure's measured width, as EnarChart's does.
export function EnarFigure({ draw, className, children }: { draw: (width: number) => string; className?: string; children?: ReactNode }) {
  const [measured, ref] = useWidth();
  const width = Math.max(240, Math.floor(measured ?? FALLBACK_W));
  let html: string;
  try {
    html = draw(width);
  } catch (err) {
    return <p className="faint enar-refused">This chart could not be drawn: {err instanceof Error ? err.message : String(err)}</p>;
  }
  return (
    <div className={`enar-fig${className ? ` ${className}` : ""}`} ref={ref}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {children}
    </div>
  );
}
