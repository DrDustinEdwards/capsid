// The chart demo's data (src/lib/demo.ts): every GET answer of the dev mock (dev/mock-api.ts, which
// serves dev/sample-feed.json and fake answers beside it), captured once into
// build/client/demos/api/<name>.json with the mock's clock pinned to DEMO_CAPTURED. The Worker's demo
// pages and the browser both read these files, moving every time to now. Runs after the build; it
// starts the mock on a free port, reads each route, and stops it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CAPTURED, demoFileName } from "../src/lib/demo.ts";

// The routes the app reads with a plain GET. packages/history needs a package name, so each configured
// package's history is read on its own, into packages/history/<name>.json (src/lib/demo.ts reads it).
const ROUTES = ["ops", "namespaces", "activity", "claims", "stale", "plan", "digest", "maintenance", "convergence", "shared-code", "completeness", "resources", "library", "trends", "push"];

// Before the mock loads: it reads the pinned clock as it starts.
process.env.WF_MOCK_NOW = DEMO_CAPTURED;
const { mockHandler } = await import("../dev/mock-api.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "client", "demos", "api");
const mock = mockHandler();
const server = createServer((req, res) => mock(req, res, () => ((res.statusCode = 404), res.end())));
await new Promise((ok) => server.listen(0, () => ok(undefined)));
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the mock did not report its port");
  const origin = `http://localhost:${address.port}`;
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
  console.log(`demo-api: ${ROUTES.length} answers and ${names.length} package histories in build/client/demos/api/`);
} finally {
  server.close();
}
