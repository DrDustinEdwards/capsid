import type { Config } from "@react-router/dev/config";

// Server rendering inside the capsid Worker (src/portal-render.ts there), as every network site
// renders: the pages live in src/, the build in build/ (client files and the server build that
// src/worker.ts wraps). subResourceIntegrity: an import map with every chunk's integrity and
// `integrity` on each modulepreload, which Integrity-Policy needs. routeDiscovery "initial": the
// route list comes with the page, as the Portal's few routes allow, so no page fetches
// /__manifest, which sits behind Access on the public /demos/ and failed on every link there
// (2026-11-03).
export default {
  appDirectory: "src",
  ssr: true,
  subResourceIntegrity: true,
  routeDiscovery: { mode: "initial" },
} satisfies Config;
