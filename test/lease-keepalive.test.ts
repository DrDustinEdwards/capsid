import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { THROTTLE_MS, claimedJobs, findCredentials, keepAlive } from "../scripts/lease-keepalive.mjs";

// The PostToolUse hook that keeps a working driver's lease alive (job_3637b6291785). It fires
// for subagent tool calls too, so a driver whose subagent is busy for hours still heartbeats;
// a dead session makes no tool calls and its lease still expires (the sweep itself is
// test-integration/jobs.test.ts, "an expired lease returns the job to queued").
// Everything here is fake: example.com, a made-up key, namespace "sample".

const KEY = "sample-driver-key-not-real";

function project(opts: { mcp?: object | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keepalive-project-"));
  if (opts.mcp !== null) {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify(opts.mcp ?? { mcpServers: { capsid: { type: "http", url: "https://mcp.example.com/ops/mcp", headers: { Authorization: `Bearer ${KEY}` } } } })
    );
  }
  return dir;
}

interface Call {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  auth: string | null;
  raw: string;
}

/** A fake /ops/mcp. improve_status lists two claimed jobs; only `held` heartbeats. */
function fakeMcp(held: string, claimed = ["job_aaaaaaaaaaaa", "job_bbbbbbbbbbbb"]) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const auth = new Headers(init?.headers).get("Authorization");
    calls.push({ method: body.method, tool: body.params?.name, args: body.params?.arguments, auth, raw: String(init?.body) });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } });
    // A namespace-scoped driver lists its own namespaces without naming one, and the Worker
    // refuses improve_status and jobs from it unless they name one (src/scope.ts).
    if (body.params?.name === "namespaces") return reply({ content: [{ type: "text", text: JSON.stringify([{ namespace: "sample" }]) }] });
    if (body.params?.name === "improve_status") {
      if (body.params.arguments?.namespace !== "sample") {
        return reply({ isError: true, content: [{ type: "text", text: "unauthorized: this caller is scoped to sample, so it must name a namespace on 'improve_status'." }] });
      }
      const status = { namespaces: [{ namespace: "sample", jobs: { claimed_jobs: claimed.map((id) => ({ id })) } }] };
      return reply({ content: [{ type: "text", text: JSON.stringify(status) }] });
    }
    if (body.params?.name === "jobs") {
      const id = body.params.arguments.id;
      return id === held
        ? reply({ content: [{ type: "text", text: "{}" }] })
        : reply({ isError: true, content: [{ type: "text", text: `${id} is not held by this caller` }] });
    }
    return reply({});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const hookInput = (extra: object = {}) => JSON.stringify({ session_id: "session-1", cwd: "/somewhere", hook_event_name: "PostToolUse", ...extra });

test("a working driver heartbeats the job it holds, and the refusal for another's job is ignored", async () => {
  const dir = project();
  const stampDir = mkdtempSync(join(tmpdir(), "keepalive-stamp-"));
  const { calls, fetchImpl } = fakeMcp("job_aaaaaaaaaaaa");
  // A tool call made INSIDE a subagent carries agent_id; the hook does the same thing.
  const out = await keepAlive({ input: hookInput({ agent_id: "agent-xyz", agent_type: "Explore" }), env: { CLAUDE_PROJECT_DIR: dir }, fetchImpl, stampDir });
  assert.deepEqual(out, { sent: 1, skipped: null });
  const beats = calls.filter((c) => c.tool === "jobs");
  assert.deepEqual(beats.map((b) => b.args?.id), ["job_aaaaaaaaaaaa", "job_bbbbbbbbbbbb"]);
  assert.ok(beats.every((b) => b.args?.action === "heartbeat" && b.args?.namespace === "sample"));
  assert.ok(calls.every((c) => c.auth === `Bearer ${KEY}`), "the key travels only in the Authorization header");
  assert.equal(calls.some((c) => c.raw.includes(KEY)), false, "the key is not in any request body");
});

test("a thousand tool calls send one batch: the second inside ten minutes does nothing, and one after it does", async () => {
  const dir = project();
  const stampDir = mkdtempSync(join(tmpdir(), "keepalive-stamp-"));
  const { calls, fetchImpl } = fakeMcp("job_aaaaaaaaaaaa");
  const t0 = Date.now();
  const first = await keepAlive({ input: hookInput(), env: { CLAUDE_PROJECT_DIR: dir }, fetchImpl, now: t0, stampDir });
  assert.equal(first.sent, 1);
  const used = calls.length;
  const second = await keepAlive({ input: hookInput(), env: { CLAUDE_PROJECT_DIR: dir }, fetchImpl, now: t0 + 60_000, stampDir });
  assert.deepEqual(second, { sent: 0, skipped: "throttled" });
  assert.equal(calls.length, used, "a throttled call sends nothing");
  const later = await keepAlive({ input: hookInput(), env: { CLAUDE_PROJECT_DIR: dir }, fetchImpl, now: t0 + THROTTLE_MS + 1000, stampDir });
  assert.equal(later.sent, 1);
  const otherSession = await keepAlive({ input: hookInput({ session_id: "session-2" }), env: { CLAUDE_PROJECT_DIR: dir }, fetchImpl, now: t0 + 61_000, stampDir });
  assert.equal(otherSession.sent, 1, "the throttle is per session");
});

test("a session that is not a driver does nothing: no .mcp.json, no capsid server, a plain-http url, bad input", async () => {
  const stampDir = mkdtempSync(join(tmpdir(), "keepalive-stamp-"));
  const { calls, fetchImpl } = fakeMcp("job_aaaaaaaaaaaa");
  const none = project({ mcp: null });
  assert.equal((await keepAlive({ input: hookInput({ session_id: "s-none" }), env: { CLAUDE_PROJECT_DIR: none }, fetchImpl, stampDir })).skipped, "no capsid key in .mcp.json");
  const other = project({ mcp: { mcpServers: { other: { url: "https://example.com/mcp" } } } });
  assert.equal((await keepAlive({ input: hookInput({ session_id: "s-other" }), env: { CLAUDE_PROJECT_DIR: other }, fetchImpl, stampDir })).skipped, "no capsid key in .mcp.json");
  const plain = project({ mcp: { mcpServers: { capsid: { url: "http://mcp.example.com/ops/mcp", headers: { Authorization: `Bearer ${KEY}` } } } } });
  const refused = await keepAlive({ input: hookInput({ session_id: "s-plain" }), env: { CLAUDE_PROJECT_DIR: plain }, fetchImpl, stampDir });
  assert.equal(refused.sent, 0, "a key is never sent in clear text");
  assert.equal((await keepAlive({ input: "not json", env: {}, fetchImpl, stampDir })).skipped, "no hook input");
  assert.equal((await keepAlive({ input: JSON.stringify({ cwd: "/x" }), env: {}, fetchImpl, stampDir })).skipped, "no session id");
  assert.equal(calls.length, 0, "none of these reached the Worker");
});

test("a Worker that cannot be reached is not an error and sends nothing further", async () => {
  const dir = project();
  const stampDir = mkdtempSync(join(tmpdir(), "keepalive-stamp-"));
  const down = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const out = await keepAlive({ input: hookInput({ session_id: "s-down" }), env: { CLAUDE_PROJECT_DIR: dir }, fetchImpl: down, stampDir });
  // The reason travels in `skipped`, so a refusal is not read as "unreachable" (the live run of
  // 2026-10-09 was refused for naming no namespace and nothing showed it).
  assert.equal(out.sent, 0);
  assert.match(out.skipped ?? "", /^the Worker could not be reached or refused the listing: .*network down/);
});

test("the key is found by walking up from a worktree, and the working directory is used when no project dir is set", async () => {
  const root = project();
  const nested = join(root, "worktrees", "feature");
  mkdirSync(nested, { recursive: true });
  assert.deepEqual(findCredentials(nested), { origin: "https://mcp.example.com", key: KEY });
  const stampDir = mkdtempSync(join(tmpdir(), "keepalive-stamp-"));
  const { fetchImpl } = fakeMcp("job_aaaaaaaaaaaa");
  const out = await keepAlive({ input: hookInput({ session_id: "s-cwd", cwd: nested }), env: {}, fetchImpl, stampDir });
  assert.equal(out.sent, 1);
});

test("claimedJobs reads improve_status and ignores a malformed answer", () => {
  assert.deepEqual(claimedJobs(JSON.stringify({ namespaces: [{ namespace: "a", jobs: { claimed_jobs: [{ id: "job_1" }, {}] } }, { namespace: "b", jobs: {} }] })), [{ id: "job_1", namespace: "a" }]);
  assert.deepEqual(claimedJobs("not json"), []);
  assert.deepEqual(claimedJobs(JSON.stringify({})), []);
});
