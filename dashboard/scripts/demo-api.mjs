import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CAPTURED, demoFile, demoFileName } from "../src/lib/demo.ts";
import { DEMO_BASE } from "../src/lib/demo-base.ts";

// The demo keeps one answer per route (src/lib/demo.ts drops the query), captured for the sample site.
const ROUTES = [
  "ops",
  "namespaces",
  "activity",
  "board",
  "prs",
  "figures?set=memory",
  "figures?set=agents",
  "figures?set=roster",
  "figures?set=problems",
  "figures?set=backups",
  "site-search?namespace=sample",
  "site-traffic?namespace=sample",
  "workers-builds?namespace=sample",
  "build-log?build=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  "maintenance",
  "convergence",
  "backups",
  "shared-code",
  "completeness",
  "resources",
  "library",
  "trends",
  "push",
];

process.env.WF_MOCK_NOW = DEMO_CAPTURED;
const { mockHandler } = await import("../dev/mock-api.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "client", "demos", "api");
const mock = mockHandler();
const server = createServer((req, res) =>
  mock(req, res, () => ((res.statusCode = 404), res.end())),
);
await new Promise((ok) => server.listen(0, () => ok(undefined)));
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the mock did not report its port");
  const origin = `http://localhost:${address.port}`;
  mkdirSync(out, { recursive: true });
  for (const route of ROUTES) {
    const res = await fetch(`${origin}/portal/api/${route}`);
    if (!res.ok) throw new Error(`the mock answered ${res.status} for ${route}`);
    const file = join(out, demoFile(`/${route}`).slice(`${DEMO_BASE}/api/`.length));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(await res.json()));
  }
  const ops = JSON.parse(readFileSync(join(out, "ops.json"), "utf8"));
  const names = (ops.live?.packages ?? []).map((/** @type {{ name: string }} */ p) => p.name);
  mkdirSync(join(out, "packages", "history"), { recursive: true });
  for (const name of names) {
    const res = await fetch(
      `${origin}/portal/api/packages/history?${new URLSearchParams({ name })}`,
    );
    if (!res.ok) throw new Error(`the mock answered ${res.status} for the history of ${name}`);
    writeFileSync(
      join(out, "packages", "history", `${demoFileName(name)}.json`),
      JSON.stringify(await res.json()),
    );
  }
  console.log(
    `demo-api: ${ROUTES.length} answers and ${names.length} package histories in build/client/demos/api/`,
  );
} finally {
  server.close();
}
