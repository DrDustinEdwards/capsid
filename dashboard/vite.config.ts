import { reactRouter } from "@react-router/dev/vite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import { mockOpsApi } from "./dev/mock-api.ts";

// The Portal, server-rendered by React Router inside the capsid Worker (src/portal-render.ts
// there; react-router.config.ts). The build writes build/client (the hashed files under
// assets/, served from the Worker's assets) and build/server, which src/worker.ts wraps into the
// one module the Worker bundles (npm run build:worker). The page's CSP carries a per-request
// nonce on React Router's scripts and none for anything else, so the build emits no other inline
// script or style, the fonts ship as files under assets/, and assetsInlineLimit: 0 keeps every
// asset a file rather than a data: URL.
//
// The dev server answers /portal/api from the mock (dev/mock-api.ts), and the pages' server
// reads go there too (server/prefetch.ts).
// Phone alerts' service worker is Capsomer's (capsomer/push-sw.js), written into the client build
// as sw.js and served at /sw.js in dev, so the Portal keeps no copy (PhoneAlerts registers it).
const pushWorker = createRequire(import.meta.url).resolve("capsomer/push-sw.js");
function pushServiceWorker(): Plugin {
  return {
    name: "capsomer-push-sw",
    configureServer(server) {
      server.middlewares.use("/sw.js", (_req, res) => {
        res.setHeader("content-type", "text/javascript");
        res.setHeader("cache-control", "no-cache");
        res.end(readFileSync(pushWorker, "utf8"));
      });
    },
    generateBundle() {
      if (this.environment.name !== "client") return;
      this.emitFile({ type: "asset", fileName: "sw.js", source: readFileSync(pushWorker, "utf8") });
    },
  };
}

export default defineConfig({
  plugins: [mockOpsApi(), reactRouter(), pushServiceWorker()],
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // The theme switch, keyboard shortcuts, tooltips, route hooks and the Portal's prefs are
            // loaded by the root and the shell on every page. Left to the automatic split they come
            // out as four small shared chunks, each compressed on its own; as one chunk the first
            // load is about 1 KB gzip smaller (.size-budget.json).
            {
              name: "shell-shared",
              test: /capsomer[\\/]dist[\\/]components[\\/](tooltip|shortcuts|theme-switch|route-hooks)[\\/]|src[\\/]lib[\\/]prefs\.ts$/,
            },
          ],
        },
      },
    },
  },
});
