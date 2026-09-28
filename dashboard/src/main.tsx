import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
// Self-hosted fonts, latin subset, only the weights the styles use (CSP font-src 'self').
import "@fontsource/schibsted-grotesk/latin-400.css";
import "@fontsource/schibsted-grotesk/latin-500.css";
import "@fontsource/schibsted-grotesk/latin-600.css";
import "@fontsource/schibsted-grotesk/latin-700.css";
import "@fontsource/schibsted-grotesk/latin-800.css";
import "@fontsource/martian-mono/latin-400.css";
import "@fontsource/martian-mono/latin-500.css";
import "@fontsource/martian-mono/latin-600.css";
import "./styles.css";
import { applySavedTheme } from "./lib/prefs";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";

applySavedTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Capsid Portal: index.html has no #root");

// The base matches vite.config.ts `base`, without the trailing slash.
createRoot(root).render(
  <StrictMode>
    <Router base="/console/app">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </Router>
  </StrictMode>,
);
