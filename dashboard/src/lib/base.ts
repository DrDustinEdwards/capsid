// Where the Portal lives, read from the page's own address: "/portal" on the dev server
// and the test hosts, "" on portal.dustinedwards.info,
// where the Portal is the whole host (src/portal-host.ts). The router and every API URL
// build on it, so one build serves both hosts. The hashed files keep their /portal/assets/
// paths on both (vite.config.ts base), which the Worker serves as they are.
// The chart demo's build answers at /demos/ on the Portal host (lib/demo.ts).
import { DEMO_BASE } from "./demo";

const PORTAL = "/portal";

/** The chart demo: sample data, no sign-in, nothing written (lib/demo.ts). Its own build
 *  (`vite build --mode demo`), so the Portal's build carries none of it. */
export const DEMO = import.meta.env.MODE === "demo";

function baseFor(pathname: string): string {
  if (DEMO) return DEMO_BASE;
  return pathname === PORTAL || pathname.startsWith(`${PORTAL}/`) ? PORTAL : "";
}

// Outside a browser (a spec importing this in Node) there is no location: the
// workers.dev base, which the dev server and the browser tests serve.
export const BASE = typeof window === "undefined" ? PORTAL : baseFor(window.location.pathname);
