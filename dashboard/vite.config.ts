import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { subresourceIntegrity } from "@dustinedwards/site-runtime/sri";
import { mockOpsApi } from "./dev/mock-api.ts";

// Served by the capsid Worker at /portal/. The Worker's CSP is
// script-src 'self'; style-src 'self'; font-src 'self', so the build emits no inline
// script or style and the fonts ship as files under assets/. Every script and modulepreload the
// build writes carries its sha384 and crossorigin (site-runtime ./sri), for Integrity-Policy.
//
// Mode "demo" (npm run build:demo) builds the same app a second time into dist/demos/, served at
// /demos/ on the Portal host with no sign-in and sample data only (src/lib/demo.ts).
export default defineConfig(({ mode }) => ({
  base: mode === "demo" ? "/demos/" : "/portal/",
  plugins: [react(), mockOpsApi(), subresourceIntegrity()],
  build: {
    outDir: mode === "demo" ? "dist/demos" : "dist",
    emptyOutDir: true,
    manifest: true,
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));
