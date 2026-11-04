import { defineConfig } from "vite";

// npm run build:worker: src/worker.ts and the server build React Router wrote (build/server),
// bundled with every dependency into build/worker/portal.js, the one module the capsid Worker
// imports (src/portal-app.ts and src/portal-demo.ts there, through the capsid-portal-pages alias). Resolved for the Workers runtime (the "workerd" and
// "worker" export conditions), so React's renderToReadableStream build is the one bundled.
export default defineConfig({
  publicDir: false,
  resolve: { conditions: ["workerd", "worker", "browser", "module", "import", "default"] },
  ssr: { noExternal: true, target: "webworker", resolve: { conditions: ["workerd", "worker", "browser", "module", "import", "default"], externalConditions: ["workerd", "worker"] } },
  build: {
    ssr: "src/worker.ts",
    outDir: "build/worker",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    rollupOptions: { output: { entryFileNames: "portal.js", format: "es", inlineDynamicImports: true } },
  },
});
