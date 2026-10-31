import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { subresourceIntegrity } from "@dustinedwards/site-runtime/sri";
import { mockOpsApi } from "./dev/mock-api.ts";

// Served by the capsid Worker at /portal/. The Worker's CSP is
// script-src 'self'; style-src 'self'; font-src 'self', so the build emits no inline
// script or style and the fonts ship as files under assets/. Every script and modulepreload the
// build writes carries its sha384 and crossorigin (site-runtime ./sri), for Integrity-Policy.
export default defineConfig({
  base: "/portal/",
  plugins: [react(), mockOpsApi(), subresourceIntegrity()],
  build: {
    outDir: "dist",
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
});
