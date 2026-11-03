// Where the Portal's reads go, from the page's own address: "" on portal.dustinedwards.info,
// where the Portal is the whole host (src/portal-host.ts in the Worker), and /demos on the chart
// demo, whose reads lib/demo.ts answers from the captured sample files. Pages render on the
// server, which reads through the Worker directly (src/server/read.ts), so this is the browser's
// half only. A component asks useDemo() (lib/router.tsx) whether it is on the demo.
import { pageBase } from "./router";

export const BASE = typeof window === "undefined" ? "" : pageBase(window.location.pathname);
