import type { Config } from "@react-router/dev/config";

// Server rendering inside the capsid Worker (src/portal-render.ts there), as every network site
// renders: the pages live in src/, the build in build/ (client files and the server build that
// src/worker.ts wraps). subResourceIntegrity: an import map with every chunk's integrity and
// `integrity` on each modulepreload, which Integrity-Policy needs.
export default {
  appDirectory: "src",
  ssr: true,
  subResourceIntegrity: true,
} satisfies Config;
