import assert from "node:assert/strict";
import { test } from "node:test";
import { capsidClient, requireHttps } from "../scripts/capsid-rpc.mjs";

// scripts/capsid-rpc.mjs: the one /ops/mcp client for mint-agents and schedule-drivers.
// Driven through a fake fetch, so every case is the real parse and the real error path.

type Sent = { method?: string; id?: number };

function fakeFetch(answer: (msg: Sent) => { status?: number; body: string }) {
  const sent: Sent[] = [];
  const impl = (async (_url: string, init: { body: string }) => {
    const msg = JSON.parse(init.body) as Sent;
    sent.push(msg);
    const { status = 200, body } = answer(msg);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const result = (id: number | undefined, value: object) => JSON.stringify({ jsonrpc: "2.0", id, result: value });

test("a tool that REFUSES throws, so a refusal is never reported as done", async () => {
  const { impl } = fakeFetch((m) => ({
    body: m.method === "tools/call" ? result(m.id, { isError: true, content: [{ type: "text", text: "write needs the write grant" }] }) : result(m.id, {}),
  }));
  const client = capsidClient("https://capsid.example.com", "k", "test", impl);
  await assert.rejects(client.tool("write", {}), /write refused: write needs the write grant/);
});

test("the session is initialized once, with the initialized notification, before the first call", async () => {
  const { impl, sent } = fakeFetch((m) => ({ body: result(m.id, { content: [{ type: "text", text: "ok" }] }) }));
  const client = capsidClient("https://capsid.example.com", "k", "test", impl);
  assert.equal(await client.tool("list", {}), "ok");
  assert.equal(await client.tool("list", {}), "ok");
  assert.deepEqual(sent.map((m) => m.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
});

test("an SSE answer is read from its last data: line, and a JSON body that mentions data: is still JSON", async () => {
  // The old parser keyed on the substring "data:" and then took .pop() of the lines
  // that START with it, so a plain JSON body containing that text threw a TypeError.
  const { impl } = fakeFetch((m) => ({
    body:
      m.method === "tools/call" && m.id === 2
        ? `event: message\ndata: ${result(m.id, { content: [{ type: "text", text: "from sse" }] })}\n\n`
        : result(m.id, { content: [{ type: "text", text: "data: in a string" }] }),
  }));
  const client = capsidClient("https://capsid.example.com", "k", "test", impl);
  assert.equal(await client.tool("read", {}), "from sse");
  assert.equal(await client.tool("read", {}), "data: in a string");
});

test("a body that is not JSON-RPC fails with the raw text, not a TypeError", async () => {
  const { impl } = fakeFetch(() => ({ body: "data:\n" }));
  const client = capsidClient("https://capsid.example.com", "k", "test", impl);
  await assert.rejects(client.tool("read", {}), /initialize -> the response was not JSON-RPC/);
});

test("an origin that is not https is refused before any request carries the key", () => {
  assert.throws(() => requireHttps("http://capsid.example.com"), /must be https/);
  assert.throws(() => requireHttps("capsid.example.com"), /not a URL/);
  const { impl, sent } = fakeFetch(() => ({ body: "{}" }));
  assert.throws(() => capsidClient("http://capsid.example.com", "k", "test", impl), /must be https/);
  assert.equal(sent.length, 0);
  assert.equal(requireHttps("https://capsid.example.com"), "https://capsid.example.com");
});
