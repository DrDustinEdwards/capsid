import { startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { applySavedTheme } from "./lib/prefs";
import { DEMO_BASE, installDemoFetch } from "./lib/demo";
import { pageBase } from "./lib/router";

// The theme line in the document set it before paint; this carries over an old single-keys choice.
applySavedTheme();
// The chart demo's reads in the browser answer from the captured sample files (lib/demo.ts).
if (pageBase(window.location.pathname) === DEMO_BASE) installDemoFetch();

startTransition(() => {
  hydrateRoot(document, <HydratedRouter />);
});
