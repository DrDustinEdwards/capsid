import { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { applySavedTheme } from "./lib/prefs";
import { DEMO_BASE, installDemoFetch } from "./lib/demo";
import { pageBase } from "./lib/router";
import { loadCharts } from "./views/charts";

// The theme line in the document set it before paint; this carries over an old single-keys choice.
applySavedTheme();
// The chart demo's reads in the browser answer from the captured sample files (lib/demo.ts).
if (pageBase(window.location.pathname) === DEMO_BASE) installDemoFetch();

// A page the server drew a chart on loads the charts' chunk before it hydrates, so the chart hydrates in place instead
// of dropping out for a moment (views/charts.ts). A failed load hydrates anyway; the chart's slot says it failed.
const charts = document.querySelector(".cap-chart, .enarratio")
  ? loadCharts().catch(() => undefined)
  : undefined;

void Promise.resolve(charts).then(() =>
  startTransition(() => {
    hydrateRoot(document, <HydratedRouter />);
  }),
);
