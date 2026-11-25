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
import "capsomer/fonts-inter.css";
import "capsomer/fonts-martian-mono.css";
import "capsomer/fonts-jost.css";
import monoFontUrl from "capsomer/fonts/martian-mono-latin-wght-normal.woff2?url";
import uiFontUrl from "capsomer/fonts/inter-latin-wght-normal.woff2?url";
// Components are in the cap.* layers so the app's unlayered styles win; a component only some pages draw brings its stylesheet with its view.
import "capsomer/tokens.css";
import "capsomer/base.css";
import "capsomer/layout-gap.css";
import "capsomer/layout-stack.css";
import "capsomer/layout-cluster.css";
import "capsomer/layout-panes.css";
import "capsomer/text-role.css";
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
import "capsomer/site-header-frame.css";
import "capsomer/site-header-letterhead.css";
import "capsomer/admin-shell.css";
import "capsomer/theme-switch.css";
import "capsomer/tabs.css";
import "capsomer/link.css";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/copy.css";
import "capsomer/icons.css";
import "capsomer/meter.css";
import "capsomer/chart-frame.css";
import "capsomer/uptime-strip.css";
import "capsomer/chips.css";
import "capsomer/message.css";
import "capsomer/table.css";
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

const NO_FLASH = themeScript(THEME_PREF);

export function Layout({ children }: { children: ReactNode }) {
  // The CSP nonce goes on every script the document renders, React Router's included.
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
        <script nonce={nonce} dangerouslySetInnerHTML={markup(NO_FLASH)} />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* A manifest is fetched without cookies unless the link says use-credentials, and this one is behind the sign-in; the demo installs nothing. */}
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
  const [client] = useState(createQueryClient);
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    </StrictMode>
  );
}

// font-display: optional leaves a face found late in its fallback, so both preload with the document.
// Same files as fonts.css's url()s so Vite emits one asset each; crossorigin, or the preload is fetched twice.
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

export function ErrorBoundary({ error }: { error: unknown }) {
  const base = pageBase(useLocation().pathname);
  return (
    <ErrorPage
      error={error}
      home={base ? `${base}/` : "/"}
      homeLabel="Go to Needs you"
      className="cap-admin-page"
      dev={import.meta.env.DEV}
    />
  );
}
