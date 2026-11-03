// The chart demo's data (src/lib/demo.ts): every GET answer of the dev mock (dev/mock-api.ts, which
// serves dev/sample-feed.json and fake answers beside it), captured once into dist/demos/api/<name>.json
// with the mock's clock pinned to DEMO_CAPTURED. The demo moves every time to now as it reads them.
// Runs after `vite build --mode demo` (npm run build:demo); it starts `vite preview` on a free port,
// reads each route, and stops it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { DEMO_CAPTURED, demoFileName } from "../src/lib/demo.ts";

// The routes the app reads with a plain GET. packages/history needs a package name, so each configured
// package's history is read on its own, into packages/history/<name>.json (src/lib/demo.ts reads it).
const ROUTES = ["ops", "namespaces", "activity", "claims", "stale", "plan", "digest", "maintenance", "convergence", "shared-code", "completeness", "library", "trends", "push"];

process.env.WF_MOCK_NOW = DEMO_CAPTURED;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "demos", "api");
const server = await preview({ root, logLevel: "warn", preview: { port: 0, strictPort: false, open: false } });
try {
  const origin = server.resolvedUrls?.local[0]?.replace(/\/portal\/?$/, "").replace(/\/$/, "");
  if (!origin) throw new Error("vite preview did not report its address");
  mkdirSync(out, { recursive: true });
  for (const route of ROUTES) {
    const res = await fetch(`${origin}/portal/api/${route}`);
    if (!res.ok) throw new Error(`the mock answered ${res.status} for ${route}`);
    writeFileSync(join(out, `${route}.json`), JSON.stringify(await res.json()));
  }
  const ops = JSON.parse(readFileSync(join(out, "ops.json"), "utf8"));
  const names = (ops.live?.packages ?? []).map((/** @type {{ name: string }} */ p) => p.name);
  mkdirSync(join(out, "packages", "history"), { recursive: true });
  for (const name of names) {
    const res = await fetch(`${origin}/portal/api/packages/history?${new URLSearchParams({ name })}`);
    if (!res.ok) throw new Error(`the mock answered ${res.status} for the history of ${name}`);
    writeFileSync(join(out, "packages", "history", `${demoFileName(name)}.json`), JSON.stringify(await res.json()));
  }
  console.log(`demo-api: ${ROUTES.length} answers and ${names.length} package histories in dist/demos/api/`);
} finally {
  await server.close();
}
