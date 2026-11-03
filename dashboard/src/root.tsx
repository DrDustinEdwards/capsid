import { QueryClientProvider } from "@tanstack/react-query";
import { themeScript } from "capsomer/theme-server";
import { StrictMode, useState, type ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useLocation, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
// The network's faces, self-hosted (CSP font-src 'self'): one variable file each, every weight.
import "capsomer/fonts.css";
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
import "capsomer/empty.css";
import "capsomer/dialog.css";
import "capsomer/popover.css";
import "capsomer/site-header.css";
import "capsomer/admin-shell.css";
import "capsomer/theme-switch.css";
import "capsomer/tabs.css";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/switch.css";
import "capsomer/switch-reason.css";
import "capsomer/meter.css";
import "capsomer/chart-frame.css";
import "capsomer/uptime-strip.css";
// The whole chart stylesheet: Enarratio's base, the token mapping, gridlines, series inks and
// the color pairs (capsomer CHANGELOG 0.56.0).
import "capsomer/enarratio.css";
import "./styles.css";
import { createQueryClient } from "./lib/api";
import { THEME_PREF } from "./lib/prefs";
import { pageBase } from "./lib/router";
import { nonceFor } from "./server/prefetch";

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
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex" />
        <meta name="theme-color" content="#01585c" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the static no-flash theme line */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* The manifest is behind the Portal's sign-in, and a manifest is fetched without cookies unless the link
            says use-credentials (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/manifest).
            The demo installs nothing. */}
        {demo ? null : <link rel="manifest" href="/site.webmanifest" crossOrigin="use-credentials" />}
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

export function meta() {
  return [{ title: "Capsid Portal" }];
}

// An address no page answers, or a page that failed to render: said in the page, with the way home.
export function ErrorBoundary({ error }: { error: unknown }) {
  const base = pageBase(useLocation().pathname);
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="page">
      <div className="callout crit" role="alert">
        <h1>{missing ? "No such page" : "The Portal failed to render"}</h1>
        <p>{missing ? "Nothing in Capsid Portal is at this address." : error instanceof Error ? error.message : "An unexpected error."}</p>
        <a className="btn" href={base ? `${base}/` : "/"}>
          Go to Needs you
        </a>
      </div>
    </main>
  );
}
