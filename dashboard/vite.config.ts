import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
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
export default defineConfig({
  plugins: [mockOpsApi(), reactRouter()],
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
