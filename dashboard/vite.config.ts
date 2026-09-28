import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mockOpsApi } from "./dev/mock-api.ts";

// Served by the capsid Worker under /console/app/. The Worker's CSP is
// script-src 'self'; style-src 'self'; font-src 'self', so the build emits no inline
// script or style and the fonts ship as files under assets/.
export default defineConfig({
  base: "/console/app/",
  plugins: [react(), mockOpsApi()],
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
