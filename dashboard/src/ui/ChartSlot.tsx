import { Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "../app/ErrorBoundary";

// A lazy chart's place: nothing while its chunk loads, and a small message, not a blank
// Portal, when the chunk fails to load or the chart fails to render. A chart Enarratio
// refuses says why in its own place (capsomer/react/chart-frame).
export function ChartSlot({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallback={<p className="faint">This chart could not be loaded. Reload the page to try again.</p>}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
