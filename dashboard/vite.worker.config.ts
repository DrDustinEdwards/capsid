import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  resolve: { conditions: ["workerd", "worker", "browser", "module", "import", "default"] },
  ssr: {
    noExternal: true,
    target: "webworker",
    resolve: {
      conditions: ["workerd", "worker", "browser", "module", "import", "default"],
      externalConditions: ["workerd", "worker"],
    },
  },
  build: {
    ssr: "src/worker.ts",
    outDir: "build/worker",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    rollupOptions: {
      output: { entryFileNames: "portal.js", format: "es", inlineDynamicImports: true },
    },
  },
});
