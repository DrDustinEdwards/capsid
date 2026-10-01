// Where the Portal lives, read from the page's own address: "/portal" on
// capsid.dustin-edwards.workers.dev (and the dev server), "" on portal.dustinedwards.info,
// where the Portal is the whole host (src/portal-host.ts). The router and every API URL
// build on it, so one build serves both hosts. The hashed files keep their /portal/assets/
// paths on both (vite.config.ts base), which the Worker serves as they are.
const PORTAL = "/portal";

export function baseFor(pathname: string): string {
  return pathname === PORTAL || pathname.startsWith(`${PORTAL}/`) ? PORTAL : "";
}

// Outside a browser (a spec importing this in Node) there is no location: the
// workers.dev base, which the dev server and the browser tests serve.
export const BASE = typeof window === "undefined" ? PORTAL : baseFor(window.location.pathname);
