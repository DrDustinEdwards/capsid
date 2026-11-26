import { startPage } from "@dustinedwards/site-runtime/page-client";
import { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { applySavedTheme } from "./lib/prefs";
import { DEMO_BASE } from "./lib/demo-base";
import { pageBase } from "./lib/router";
import { loadCharts } from "./views/charts";

startPage();
applySavedTheme();
// The demo's fetch is installed before hydrating; the demo's module loads only under /demos.
const demo =
  pageBase(window.location.pathname) === DEMO_BASE
    ? import("./lib/demo").then((m) => m.installDemoFetch())
    : undefined;

// Load the charts' chunk before hydrating a server-drawn chart (views/charts.ts); a failed load hydrates anyway.
const charts = document.querySelector(".cap-chart, .enarratio")
  ? loadCharts().catch(() => undefined)
  : undefined;

void Promise.all([charts, demo]).then(() =>
  startTransition(() => {
    hydrateRoot(document, <HydratedRouter />);
  }),
);
