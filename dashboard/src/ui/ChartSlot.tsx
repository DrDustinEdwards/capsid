import { Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "../app/ErrorBoundary";

export function ChartSlot({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={
        <p className="cap-text" data-tone="dim">
          This chart could not be loaded. Reload the page to try again.
        </p>
      }
    >
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
