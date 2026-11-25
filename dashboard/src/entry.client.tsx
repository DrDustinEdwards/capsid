import { startPage } from "@dustinedwards/site-runtime/page-client";
import { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { applySavedTheme } from "./lib/prefs";
import { DEMO_BASE, installDemoFetch } from "./lib/demo";
import { pageBase } from "./lib/router";
import { loadCharts } from "./views/charts";

startPage();
applySavedTheme();
if (pageBase(window.location.pathname) === DEMO_BASE) installDemoFetch();

// Load the charts' chunk before hydrating a server-drawn chart (views/charts.ts); a failed load hydrates anyway.
const charts = document.querySelector(".cap-chart, .enarratio")
  ? loadCharts().catch(() => undefined)
  : undefined;

void Promise.resolve(charts).then(() =>
  startTransition(() => {
    hydrateRoot(document, <HydratedRouter />);
  }),
);
