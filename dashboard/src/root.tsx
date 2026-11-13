import { QueryClientProvider } from "@tanstack/react-query";
import { ErrorPage, errorTitle } from "capsomer/react/error-page";
import { themeScript } from "capsomer/theme-server";
import { StrictMode, useState, type ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
// The network's faces, self-hosted (CSP font-src 'self'): one variable file each, every weight.
import "capsomer/fonts.css";
import monoFontUrl from "capsomer/fonts/martian-mono-latin-wght-normal.woff2?url";
import uiFontUrl from "capsomer/fonts/inter-latin-wght-normal.woff2?url";
// Capsomer: its layer order and tokens first, then its element defaults (base.css, which carries
// the utility classes), then its components (all in the cap.* layers, so the app's unlayered
// styles win), then the app's styles. Every stylesheet a server-rendered part of a page needs is
// here, not only in the lazy chunk that draws it: a page read with scripts off has no chunk.
import "capsomer/tokens.css";
import "capsomer/base.css";
import "capsomer/family-teal.css";
import "capsomer/site-capsid-portal.css";
import "capsomer/status.css";
import "capsomer/panel.css";
import "capsomer/read-state.css";
import "capsomer/empty.css";
import "capsomer/error-page.css";
import "capsomer/skeleton.css";
import "capsomer/dialog.css";
import "capsomer/popover.css";
import "capsomer/site-header.css";
import "capsomer/admin-shell.css";
import "capsomer/theme-switch.css";
import "capsomer/tabs.css";
import "capsomer/link.css";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/filter-bar.css";
import "capsomer/copy.css";
import "capsomer/icons.css";
import "capsomer/field.css";
import "capsomer/repeater-field.css";
import "capsomer/switch.css";
import "capsomer/switch-reason.css";
import "capsomer/meter.css";
import "capsomer/chart-frame.css";
import "capsomer/uptime-strip.css";
import "capsomer/chips.css";
import "capsomer/message.css";
import "capsomer/table.css";
// The whole chart stylesheet: Enarratio's base, the token mapping, gridlines, series inks and
// the color pairs (capsomer CHANGELOG 0.56.0).
import "capsomer/enarratio.css";
import "./styles.css";
import { createQueryClient } from "./lib/api";
import { THEME_PREF } from "./lib/prefs";
import { pageBase } from "./lib/router";
import { nonceFor } from "./server/prefetch";
import { markup } from "capsomer/behavior/trusted-html";

export function loader({ context }: LoaderFunctionArgs) {
  return { nonce: nonceFor(context) };
}

// The theme before first paint: the saved choice, else the system's (Capsomer's themeScript).
const NO_FLASH = themeScript(THEME_PREF);

export function Layout({ children }: { children: ReactNode }) {
  // The CSP nonce (the Worker's per-request policy, src/portal-render.ts) on every script the
  // document renders: the theme line, React Router's hydration data and its module scripts.
  const nonce = useRouteLoaderData<typeof loader>("root")?.nonce ?? "";
  const demo = pageBase(useLocation().pathname) !== "";
  return (
    <html lang="en" data-cap-site="capsid-portal" data-family="teal">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="text-scale" content="scale" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#01585c" />
        {/* The static no-flash theme line, set before first paint. */}
        <script nonce={nonce} dangerouslySetInnerHTML={markup(NO_FLASH)} />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* The manifest is behind the Portal's sign-in, and a manifest is fetched without cookies unless the link
            says use-credentials (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/manifest).
            The demo installs nothing. */}
        {demo ? null : (
          <link rel="manifest" href="/site.webmanifest" crossOrigin="use-credentials" />
        )}
        <Meta />
        <Links nonce={nonce} />
      </head>
      <body>
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function Root() {
  // One client per page load (and, on the server, per request: server/prefetch.ts), so no
  // request shares a cache.
  const [client] = useState(createQueryClient);
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    </StrictMode>
  );
}

// Both faces preloaded: every page draws the UI face and the mono labels above the fold, and they load
// with font-display: optional (Capsomer 0.68), so a face found late, once the stylesheet has arrived,
// leaves the visit in its size-matched fallback. A preload starts both with the document. Same files as
// fonts.css's url()s, so Vite emits one asset each; crossorigin, or the preload is fetched twice.
export const links = () =>
  [uiFontUrl, monoFontUrl].map((href) => ({
    rel: "preload",
    href,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous" as const,
  }));

export function meta({ error }: { error?: unknown }) {
  return [{ title: error ? errorTitle(error, "Capsid Portal") : "Capsid Portal" }];
}

// An address no page answers, or a page that failed to render: Capsomer's shared error page, so the
// words, the noindex and the way out match every other site's. Only development shows the thrown
// message; the old boundary printed it to any visitor.
export function ErrorBoundary({ error }: { error: unknown }) {
  const base = pageBase(useLocation().pathname);
  return (
    <ErrorPage
      error={error}
      home={base ? `${base}/` : "/"}
      homeLabel="Go to Needs you"
      className="page"
      dev={import.meta.env.DEV}
    />
  );
}
