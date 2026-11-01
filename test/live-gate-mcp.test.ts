import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { EXPECTED_TOOLS, eraSteps, probeMcp, rpcMessage, stepProblem } from "../scripts/mcp-probe-lib.mjs";
import { ROLES } from "../scripts/mint-agents.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import type { Agent } from "../src/agents.ts";
import { serveMcp } from "../src/mcp-handler.ts";
import { CAPSID_TOOLS } from "../src/tools/surface.ts";
import { buildServer } from "../src/server.ts";
import { toolListed } from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { breaking, type Handler, healthy, NON_HTML, run } from "./verify-live-stub.ts";

// Live gate 8 (scripts/mcp-probe-lib.mjs, job_bb06c9be24c4): a real MCP call after every
// deploy. The script is run against the stub Worker of ./verify-live-stub.ts with its
// /ops/mcp bridged to the REAL handler (src/mcp-handler.ts and buildServer), as the
// live-probe agent. Each plant breaks the handler a different way and must make the
// script exit 1, which is the exit ci.yml rolls the deploy back on.

const KEY = "live-probe-test-key";

// The live-probe role, as an agent: its scopes from scripts/mint-agents.ts, not restated.
function probeAgent(): Agent {
  const role = ROLES.find((r) => r.name === "live-probe");
  assert.ok(role, "no live-probe role in scripts/mint-agents.ts");
  const scopes = defaultScopes(role.namespaces);
  type Scopes = Agent["scopes"];
  scopes.grants = role.grants as Scopes["grants"];
  scopes.tools = role.tools as Scopes["tools"];
  scopes.repos = role.repos as Scopes["repos"];
  return { id: "agent_liveprobe01", name: "live-probe", kind: role.kind as Agent["kind"], actor: "agent:live-probe", scopes, admin: false, row: null };
}

const conventions = { id: 1, namespace: "capsid", path: "conventions.md", title: "Conventions", body: "The portfolio conventions.", type: "core" };
const probeEnv = (documents = [conventions]) => fakeEnv({ DB: fakeD1({ documents, namespaces: [{ namespace: "capsid", repos: "[]" }] }).db, APP_KV: fakeKv({}).kv });
const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

type Serve = (request: Request) => Promise<Response>;

// The real handler, as /ops/mcp serves it behind its key check (src/routes.ts).
const realHandler = (env = probeEnv(), build = () => buildServer(env, probeAgent())): Serve => (request) => serveMcp(request, env, ctx(), "/ops/mcp", build);

// Node's request into a Fetch Request, through `serve`, and back. The bearer check plays
// resolveAgent: anything but the probe key is the 401 the Worker sends.
function bridge(serve: Serve): Handler {
  return breaking((req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ops/mcp") return false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401, { ...NON_HTML, "content-type": "text/plain; charset=utf-8" });
          res.end("unauthorized: valid operator key or agent key required");
          return;
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const response = await serve(new Request(`https://mcp.example.com/ops/mcp`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      })();
    });
    return true;
  });
}

const withKey = { CAPSID_LIVE_PROBE_KEY: KEY };

test("EXPECTED_TOOLS is the count of Capsid's served tools a read grant can call, from CAPSID_TOOLS", () => {
  const readable = CAPSID_TOOLS.filter((tool) => toolListed(probeAgent(), tool));
  assert.equal(EXPECTED_TOOLS, readable.length, "scripts/mcp-probe-lib.mjs EXPECTED_TOOLS drifted from the served surface");
});

test("an event-stream answer is read off its data line", () => {
  const msg = { jsonrpc: "2.0", id: 1, result: { ok: true } };
  assert.deepEqual(rpcMessage(`event: message\ndata: ${JSON.stringify(msg)}\n\n`), msg);
  assert.deepEqual(rpcMessage(JSON.stringify(msg)), msg);
  assert.equal(rpcMessage("<html>"), null);
});

test("the probe passes against the real handler in both eras, as the live-probe agent", async () => {
  const serve = realHandler();
  const post = async (body: string, headers: Record<string, string>) => {
    const response = await serve(new Request("https://mcp.example.com/ops/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body }));
    return { status: response.status, text: await response.text() };
  };
  assert.deepEqual(await probeMcp(post), []);
});

test("a 401 says the key was refused, and a JSON-RPC error names its code", () => {
  const [step] = eraSteps("2025-11-25");
  assert.match(String(stepProblem(step, 401, "")), /probe key was refused/);
  assert.match(String(stepProblem(step, 200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } }))), /JSON-RPC error -32603: boom/);
});

test("a 2026-07-28 tools/list without its cache fields is a refusal", () => {
  const list = eraSteps("2026-07-28").find((s: { method: string }) => s.method === "tools/list");
  const tools = Array.from({ length: EXPECTED_TOOLS }, (_, i) => ({ name: i === 0 ? "capsid_read_doc" : `t${i}` }));
  assert.equal(stepProblem(list, 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools, ttlMs: 60000, cacheScope: "public" } })), null);
  assert.match(String(stepProblem(list, 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }))), /no ttlMs\/cacheScope/);
});

// The script, end to end.

test("gate 8 passes against the real handler, and the run exits 0", async () => {
  const { code, out } = await run(bridge(realHandler()), () => false, withKey);
  assert.equal(code, 0, out);
  assert.match(out, /PASS {2}8 MCP call through \/ops\/mcp\n.*2025-11-25 and 2026-07-28/);
});

test("with no key the gate says it asserted nothing, and does not fail the run", async () => {
  const { code, out } = await run(healthy, () => false);
  assert.equal(code, 0, out);
  assert.match(out, /PASS {2}8 MCP call through \/ops\/mcp\n.*SKIPPED: no CAPSID_LIVE_PROBE_KEY/);
});

// The plants. Each is a deploy whose sign-in gates all pass and whose connection is
// broken; each must be a refusal (exit 1), the exit the rollback runs on.

async function refused(serve: Serve, pattern: RegExp, extraEnv: Record<string, string> = withKey) {
  const { code, out } = await run(bridge(serve), () => false, extraEnv);
  assert.equal(code, 1, `the gate did not refuse, so the rollback would not run:\n${out}`);
  assert.match(out, /FAIL {2}8 MCP call through \/ops\/mcp/);
  assert.match(out, pattern);
  assert.match(out, /FAILED GATES: 8 MCP call through \/ops\/mcp$/m, "another gate failed too, so this run does not isolate gate 8");
}

test("PLANT: a handler that answers 500 to every call is refused", async () => {
  await refused(async () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }), { status: 500, headers: { "content-type": "application/json" } }), /2025-11-25 initialize: HTTP 500.*2026-07-28 server\/discover: HTTP 500/);
});

test("PLANT: a deploy whose store lost the document is refused at the read", async () => {
  await refused(realHandler(probeEnv([])), /2025-11-25 tools\/call capsid_read_doc: the tool refused/);
});

test("PLANT: a deploy that dropped the legacy shim is refused for 2025-11-25 clients", async () => {
  const env = probeEnv();
  // src/mcp-handler.ts without isLegacyRequest: the modern handler alone.
  const modernOnly: Serve = (request) => createMcpHandler(() => buildServer(env, probeAgent()), { route: "/ops/mcp", legacy: "reject" })(request, env, ctx());
  await refused(modernOnly, /2025-11-25 initialize: /);
});

test("PLANT: a deploy that lost a tool is refused at tools/list", async () => {
  const env = probeEnv();
  const original = McpServer.prototype.registerTool;
  const dropOne = () => {
    McpServer.prototype.registerTool = function (this: McpServer, ...args: unknown[]) {
      if (args[0] === "capsid_inspect_repo") return undefined as never;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as unknown as typeof original;
    try {
      return buildServer(env, probeAgent());
    } finally {
      McpServer.prototype.registerTool = original;
    }
  };
  await refused(realHandler(env, dropOne), new RegExp(`tools/list: ${EXPECTED_TOOLS - 1} tools, expected ${EXPECTED_TOOLS}`));
});

test("PLANT: a key the deploy no longer resolves is refused, naming the key", async () => {
  await refused(realHandler(), /probe key was refused/, { CAPSID_LIVE_PROBE_KEY: "not-the-key" });
});

test("an /ops/mcp that never answers is could-not-run (exit 3), not a refusal", async () => {
  const { code, out } = await run(bridge(realHandler()), (req) => new URL(req.url ?? "/", "http://x").pathname === "/ops/mcp" && req.method === "POST" && Boolean(req.headers.authorization), withKey);
  assert.equal(code, 3, out);
  assert.match(out, /NORUN {2}8 MCP call through \/ops\/mcp/);
});
