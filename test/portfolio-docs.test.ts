import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { isPortfolioPath, PORTFOLIO_DOCS } from "../src/portfolio-docs.ts";
import { fakeD1, fakeEnv, fakeKv, type DocRow } from "./fakes.ts";

// Every namespace driver may READ the portfolio documents in capsid (conventions, the
// decisions log and its volumes, the rulings, capsid's core) and nothing else there.
// Every call goes through a real MCP client, so the registrar's check and the listing
// handlers' filters are both on the path.

// The allowed paths as they exist in the store on 2026-10-08, plus capsid's core.
const ALLOWED = [
  "conventions.md",
  "core.md",
  "decisions.md",
  "decisions-vol-4.md",
  "decisions-vol-5.md",
  "archive/decisions-vol-1.md",
  "archive/decisions-vol-7.md",
  "rulings/testing-2026-10-04.md",
  "rulings/shared-homes-2026-10-06.md",
];

// What must stay capsid-only, including names one character away from an allowed one.
const DENIED = [
  "policy/gates.md",
  "research/design-seat-session-hardening.md",
  "jobs/job_0123456789ab.md",
  "repo-structure.md",
  "rulings-secret/plan.md",
  "rulings/deeper/nested.md",
  "archive/decisions-notes.md",
  "decisions-vol-x.md",
  "decisions-archive.md",
  "archive/other.md",
  "episodic-2026-10-01.md",
];

const DOCS: DocRow[] = [
  ...ALLOWED.map((path) => ({ namespace: "capsid", path, title: path, body: `ALLOWED ${path}`, type: "decision" })),
  ...DENIED.map((path) => ({ namespace: "capsid", path, title: path, body: `SECRET ${path}`, type: "decision" })),
  { namespace: "carrel", path: "core.md", title: "carrel core", body: "carrel's own", type: "core" },
];

const NAMESPACES = [
  { namespace: "capsid", repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid", label: "primary" }]) },
  { namespace: "carrel", repos: JSON.stringify([{ repo: "DrDustinEdwards/carrel", label: "primary" }]) },
];

// A driver as the roster mints one: one namespace, read and write, no flags.
function driver(namespace: string): Agent {
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name: `${namespace}-driver`, kind: "driver", actor: `agent:${namespace}-driver`, scopes, admin: false, row: null };
}

type Result = { isError?: boolean; text: string };

async function connect(caller: Agent, opts: { ftsRows?: number } = {}) {
  const d1 = fakeD1({ documents: DOCS, namespaces: NAMESPACES, ...opts });
  const server = buildServer(fakeEnv({ DB: d1.db, APP_KV: fakeKv({ seedToken: true }).kv }), caller);
  const client = new Client({ name: "portfolio-docs", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    try {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      return { isError: r.isError, text: r.content.map((c) => c.text ?? "").join("\n") };
    } catch (err) {
      // An argument the schema rejects can surface as a protocol error.
      return { isError: true, text: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    call,
    writes: d1.recorded,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const paths = (r: Result): string[] => (JSON.parse(r.text) as { documents: Array<{ path: string }> }).documents.map((d) => d.path);

test("PORTFOLIO_DOCS is exactly the documents, volumes, folder and tools this test names", () => {
  assert.deepEqual(PORTFOLIO_DOCS, {
    namespace: "capsid",
    documents: ["conventions.md", "core.md", "decisions.md"],
    volumes: ["decisions-vol-", "archive/decisions-vol-"],
    folders: ["rulings/"],
    tools: ["read", "list", "find", "search"],
  });
});

test("isPortfolioPath admits the allowed paths and refuses traversal, case, encoding and prefix confusion", () => {
  for (const path of ALLOWED) assert.equal(isPortfolioPath(path), true, `${path} should be allowed`);
  const refused = [
    ...DENIED,
    "rulings/../policy/gates.md",
    "rulings/./testing-2026-10-04.md",
    "rulings/%2e%2e/policy/gates.md",
    "rulings/%2E%2E/policy/gates.md",
    "rulings\\..\\policy\\gates.md",
    "Rulings/testing-2026-10-04.md",
    "CONVENTIONS.md",
    "Conventions.md",
    "conventions.md/",
    "rulings/",
    "rulings",
    "/conventions.md",
    "./conventions.md",
    "conventions.md ",
    "rulings//testing-2026-10-04.md",
    "decisions-vol-0.md",
    "decisions-vol-.md",
    "decisions-vol-5.md.bak",
    "archive/archive/decisions-vol-1.md",
    "x/conventions.md",
    "",
  ];
  for (const path of refused) assert.equal(isPortfolioPath(path), false, `${JSON.stringify(path)} should be refused`);
});

test("a namespace driver reads every portfolio document in capsid", async () => {
  const { call, close } = await connect(driver("carrel"));
  for (const path of ALLOWED) {
    const r = await call("read", { namespace: "capsid", path });
    assert.ok(!r.isError, `${path} was refused: ${r.text}`);
    assert.equal(JSON.parse(r.text).body, `ALLOWED ${path}`);
  }
  await close();
});

test("PLANT: a namespace driver is refused every capsid path outside the portfolio allowlist", async () => {
  const { call, close } = await connect(driver("carrel"));
  for (const path of DENIED) {
    const r = await call("read", { namespace: "capsid", path });
    assert.equal(r.isError, true, `${path} was read by a carrel driver`);
    assert.match(r.text, /not scoped to the 'capsid' namespace/, `${path}: ${r.text}`);
    assert.doesNotMatch(r.text, /SECRET/);
  }
  await close();
});

test("traversal, case and encoded paths are refused and leak nothing, whichever check refuses them", async () => {
  const { call, close } = await connect(driver("carrel"));
  for (const path of [
    "rulings/../policy/gates.md",
    "rulings/%2e%2e/policy/gates.md",
    "Rulings/testing-2026-10-04.md",
    "CONVENTIONS.md",
    "rulings/",
    "conventions.md/",
    "rulings\\..\\policy\\gates.md",
  ]) {
    const r = await call("read", { namespace: "capsid", path });
    assert.equal(r.isError, true, `${path} was not refused`);
    assert.doesNotMatch(r.text, /SECRET|ALLOWED/, `${path} leaked a body: ${r.text}`);
  }
  await close();
});

test("no write, edge or history tool reaches a portfolio document for a namespace driver", async () => {
  const { call, writes, close } = await connect(driver("carrel"));
  const path = "conventions.md";
  const calls: Array<[string, Record<string, unknown>]> = [
    ["write", { namespace: "capsid", path, body: "rewritten", confirm: true }],
    ["delete", { namespace: "capsid", path, confirm: true }],
    ["move", { namespace: "capsid", path, new_path: "moved.md", confirm: true }],
    ["restore", { namespace: "capsid", path, version_id: 1, confirm: true }],
    ["history", { namespace: "capsid", path }],
    ["backlinks", { namespace: "capsid", path }],
    ["brief", { namespace: "capsid" }],
  ];
  for (const [name, args] of calls) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} on capsid/${path} was not refused: ${r.text}`);
    assert.match(r.text, /not scoped to the 'capsid' namespace/, `${name}: ${r.text}`);
  }
  assert.equal(writes.length, 0, "a refused call wrote something");
  await close();
});

test("PLANT: list, find and search in capsid return only the portfolio documents to a namespace driver", async () => {
  const { call, close } = await connect(driver("carrel"), { ftsRows: 3 });
  const listed = await call("list", { namespace: "capsid" });
  assert.ok(!listed.isError, listed.text);
  assert.deepEqual(paths(listed), [...ALLOWED].sort());

  const found = await call("find", { namespace: "capsid", glob: "*" });
  assert.ok(!found.isError, found.text);
  assert.deepEqual(paths(found), [...ALLOWED].sort());

  const foundNear = await call("find", { namespace: "capsid", glob: "rulings*" });
  assert.deepEqual(paths(foundNear), ALLOWED.filter((p) => p.startsWith("rulings/")).sort(), "rulings-secret/ matched rulings/");

  // The fake's FTS answers conventions.md, hit-1.md and hit-2.md whatever the query.
  const searched = await call("search", { namespace: "capsid", query: "anything" });
  assert.ok(!searched.isError, searched.text);
  assert.deepEqual(paths(searched), ["conventions.md"]);
  await close();
});

test("a narrowed driver still cannot list, find or search with no namespace", async () => {
  const { call, close } = await connect(driver("carrel"));
  for (const [name, args] of [
    ["list", {}],
    ["find", { glob: "*" }],
    ["search", { query: "anything" }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} with no namespace was answered`);
    assert.match(r.text, /must name a namespace/);
  }
  await close();
});

test("THE INNOCENT DIRECTION: capsid's own driver still lists everything in capsid, and carrel's driver its own namespace", async () => {
  const own = await connect(driver("capsid"));
  const all = await own.call("list", { namespace: "capsid" });
  assert.equal(paths(all).length, ALLOWED.length + DENIED.length, "the filter reached a caller scoped to capsid");
  const policy = await own.call("read", { namespace: "capsid", path: "policy/gates.md" });
  assert.ok(!policy.isError, policy.text);
  await own.close();

  const carrel = await connect(driver("carrel"));
  const mine = await carrel.call("read", { namespace: "carrel", path: "core.md" });
  assert.equal(JSON.parse(mine.text).body, "carrel's own");
  await carrel.close();
});

test("brief for any namespace names the portfolio documents to read first", async () => {
  const { call, close } = await connect(driver("carrel"));
  const r = await call("brief", { namespace: "carrel" });
  assert.ok(!r.isError, r.text);
  const out = JSON.parse(r.text) as { portfolio_documents: { namespace: string; read_first: string[]; allowlist: string[]; note: string } };
  assert.equal(out.portfolio_documents.namespace, "capsid");
  assert.deepEqual(out.portfolio_documents.read_first, [...ALLOWED].sort());
  assert.deepEqual(out.portfolio_documents.allowlist, [
    "conventions.md",
    "core.md",
    "decisions.md",
    "decisions-vol-<n>.md",
    "archive/decisions-vol-<n>.md",
    "rulings/<name>.md",
  ]);
  await close();
});
