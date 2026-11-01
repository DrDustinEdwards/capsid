import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
// The family's faces, self-hosted (CSP font-src 'self'): one variable file each, every weight.
import "capsomer/fonts.css";
// Capsomer: its layer order and tokens first, then its element defaults (base.css, which carries
// the utility classes), then its components (all in the cap.* layers, so
// the app's unlayered styles win), then the app's styles.
import "capsomer/tokens.css";
import "capsomer/base.css";
import "capsomer/family-teal.css";
import "capsomer/site-capsid-portal.css";
import "capsomer/status.css";
import "capsomer/panel.css";
import "capsomer/empty.css";
import "capsomer/dialog.css";
import "capsomer/popover.css";
import "capsomer/site-header.css";
import "capsomer/admin-shell.css";
import "capsomer/theme-switch.css";
import "capsomer/tabs.css";
// The whole chart stylesheet: Enarratio's base, the token mapping, gridlines, series inks and
// the color pairs (capsomer CHANGELOG 0.56.0).
import "capsomer/enarratio.css";
import "./styles.css";
import { applySavedTheme } from "./lib/prefs";
import { BASE, DEMO } from "./lib/base";
import { installDemoFetch } from "./lib/demo";
import { queryClient } from "./lib/api";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";

applySavedTheme();
if (DEMO) installDemoFetch();

const root = document.getElementById("root");
if (!root) throw new Error("Watch Floor: index.html has no #root");

// The base matches vite.config.ts `base`, without the trailing slash.
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router base={BASE}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
