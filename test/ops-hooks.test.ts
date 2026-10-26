import assert from "node:assert/strict";
import { test } from "node:test";

import { adminAgentForEmail, legacyAgent, type Agent } from "../src/agents.ts";
import { defaultScopes, serializeScopes, type AgentKind, type AgentRow } from "../src/agents-schema.ts";
import { opsSessionFrom, type SessionFeedRow } from "../src/ops-feed.ts";
import {
  HOOK_EVENTS,
  HOOK_MAX_BYTES,
  handleOpsHooks,
  hookStatements,
  NEEDS_INPUT_TYPES,
  OPS_HOOKS_PATH,
  parseHook,
  type ParsedHook,
} from "../src/ops-hooks.ts";
import { sessionCallerRefusal } from "../src/ops-session-auth.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// The hook receiver's parse, its allowlist and its caller check (src/ops-hooks.ts).
// The writes themselves, the auth through the whole Worker, the needs_input cycle and
// the size cap run against real D1 in test-integration/ops-hooks.test.ts.

const SESSION = "5e55a0a1-0000-4000-8000-00000000000a";
// Planted in every field the receiver must never keep. A match anywhere in what is
// bound to a statement is a leak.
const MARKER = "PLANTED-CONTENT-7f3a";

function parsed(body: Record<string, unknown>): ParsedHook {
  const result = parseHook(JSON.stringify({ session_id: SESSION, ...body }));
  assert.ok(result.ok, result.ok ? "" : result.refusal);
  return result.hook;
}

// ---- parsing ------------------------------------------------------------------

test("a needs-input Notification sets needs_input and keeps its type, title and message only", () => {
  for (const type of NEEDS_INPUT_TYPES) {
    const hook = parsed({ hook_event_name: "Notification", notification_type: type, title: "Permission needed", message: "Claude needs your permission to use Bash" });
    assert.equal(hook.needs_input, 1, type);
    assert.equal(hook.subtype, type);
    assert.equal(hook.notification_type, type);
    assert.deepEqual(JSON.parse(hook.detail ?? "null"), { title: "Permission needed", message: "Claude needs your permission to use Bash" });
  }
  assert.equal(NEEDS_INPUT_TYPES.length, 5);
});

test("agent_completed clears needs_input, another Notification leaves it, and every other event clears it", () => {
  assert.equal(parsed({ hook_event_name: "Notification", notification_type: "agent_completed" }).needs_input, 0);
  assert.equal(parsed({ hook_event_name: "Notification", notification_type: "auth_success" }).needs_input, null);
  assert.equal(parsed({ hook_event_name: "Notification" }).needs_input, null);
  for (const event of HOOK_EVENTS.filter((e) => e !== "Notification")) {
    assert.equal(parsed({ hook_event_name: event }).needs_input, 0, event);
  }
});

test("StopFailure records its error and the API error string capped at 300 characters", () => {
  const hook = parsed({ hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "x".repeat(900) });
  assert.equal(hook.failure, "rate_limit");
  assert.equal(hook.subtype, "rate_limit");
  assert.equal((JSON.parse(hook.detail ?? "{}") as { error: string }).error.length, 300);
  // An error word that is not a type word is still a failure, kept as unknown.
  assert.equal(parsed({ hook_event_name: "StopFailure", error: "Not A Word!" }).failure, "unknown");
});

test("a Stop clears the failure, SessionEnd ends the session and SessionStart reopens it", () => {
  const stop = parsed({ hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(stop.clears_failure, true);
  assert.equal(stop.detail, null);
  const end = parsed({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  assert.equal(end.end_mode, "end");
  assert.equal(end.end_reason, "prompt_input_exit");
  assert.equal(parsed({ hook_event_name: "SessionEnd", reason: "Something Else" }).end_reason, "other");
  const start = parsed({ hook_event_name: "SessionStart", source: "resume", model: "claude-sample-model", permission_mode: "acceptEdits" });
  assert.equal(start.end_mode, "reopen");
  assert.equal(start.source, "resume");
  assert.equal(start.model, "claude-sample-model");
  assert.equal(start.permission_mode, "acceptEdits");
});

test("ConfigChange keeps its source and the file path, capped", () => {
  const hook = parsed({ hook_event_name: "ConfigChange", source: "project_settings", file_path: "/home/sample/.claude/settings.json" });
  assert.equal(hook.subtype, "project_settings");
  assert.deepEqual(JSON.parse(hook.detail ?? "null"), { file_path: "/home/sample/.claude/settings.json" });
});

test("control characters are folded and a field outside its pattern is dropped, not stored raw", () => {
  const hook = parsed({ hook_event_name: "Notification", notification_type: "idle_prompt", title: "a\u0000b\nc", message: "   " });
  assert.deepEqual(JSON.parse(hook.detail ?? "null"), { title: "a b c" });
  const start = parsed({ hook_event_name: "SessionStart", source: "startup", model: "has space'; DROP", permission_mode: "x".repeat(40) });
  assert.equal(start.model, null);
  assert.equal(start.permission_mode, null);
});

test("a body that is not an event this receiver records is refused with the reason", () => {
  const refuse = (raw: string) => {
    const result = parseHook(raw);
    assert.equal(result.ok, false, raw.slice(0, 60));
    return result.ok ? "" : result.refusal;
  };
  assert.match(refuse("not json"), /not JSON/);
  assert.match(refuse("[]"), /not a JSON object/);
  assert.match(refuse(JSON.stringify({ hook_event_name: "Stop" })), /session_id/);
  assert.match(refuse(JSON.stringify({ session_id: "../etc", hook_event_name: "Stop" })), /session_id/);
  assert.match(refuse(JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse" })), /SessionStart, Notification/);
  assert.equal(HOOK_EVENTS.length, 8);
});

const tool = (body: Record<string, unknown>) => parsed({ hook_event_name: "PostToolUse", tool_use_id: "toolu_01", duration_ms: 12, ...body });
const detailOf = (hook: ParsedHook) => JSON.parse(hook.detail ?? "null") as Record<string, string> | null;

test("tool events: Edit, Write and MultiEdit keep the file path, capped, and no other tool keeps one", () => {
  for (const name of ["Edit", "Write", "MultiEdit"]) {
    const hook = tool({ tool_name: name, tool_input: { file_path: "/home/sample/src/a.ts", content: MARKER } });
    assert.equal(hook.subtype, name);
    assert.deepEqual(detailOf(hook), { file_path: "/home/sample/src/a.ts" });
    assert.equal(hook.needs_input, 0);
    assert.equal(hook.end_mode, "keep");
    assert.equal(hook.clears_failure, false);
    assert.equal(hook.failure, null);
  }
  assert.equal(detailOf(tool({ tool_name: "Edit", tool_input: { file_path: "/a/" + "x".repeat(400) } }))?.file_path.length, 300);
  const read = tool({ tool_name: "Read", tool_input: { file_path: "/home/sample/secret.txt" } });
  assert.equal(read.subtype, "Read");
  assert.equal(read.detail, null);
  assert.equal(tool({ tool_name: "mcp__capsid__capsid_read_doc", tool_input: { path: "x" } }).subtype, "mcp__capsid__capsid_read_doc");
});

test("tool events: Bash keeps the basename of the first word and the exit code, and never an env assignment", () => {
  assert.deepEqual(detailOf(tool({ tool_name: "Bash", tool_input: { command: "npm test -- --token abc" } })), { command: "npm", exit_code: "0" });
  assert.deepEqual(detailOf(tool({ tool_name: "Bash", tool_input: { command: "/usr/bin/git status" } })), { command: "git", exit_code: "0" });
  assert.deepEqual(detailOf(tool({ tool_name: "Bash", tool_input: { command: "TOKEN=abc npm test" } })), { exit_code: "0" });
  assert.deepEqual(detailOf(tool({ tool_name: "Bash", tool_input: { command: '"quoted" x' } })), { exit_code: "0" });
  assert.deepEqual(detailOf(tool({ tool_name: "Bash", tool_input: {} })), { exit_code: "0" });
});

test("tool events: a failure keeps the exit code from the first line of error, and is_interrupt", () => {
  const fail = (body: Record<string, unknown>) => parsed({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, ...body });
  assert.deepEqual(detailOf(fail({ error: `Exit code 2\nstderr ${MARKER}` })), { command: "npm", exit_code: "2" });
  assert.deepEqual(detailOf(fail({ error: "Exit code -1" })), { command: "npm", exit_code: "-1" });
  // No Exit code line: the command did not run to an exit, so no exit_code is kept.
  assert.deepEqual(detailOf(fail({ error: `Permission denied ${MARKER}` })), { command: "npm" });
  assert.deepEqual(detailOf(fail({ error: `the line before\nExit code 2` })), { command: "npm" });
  assert.deepEqual(detailOf(fail({})), { command: "npm" });
  assert.deepEqual(detailOf(fail({ error: "Exit code 130", is_interrupt: true })), { command: "npm", exit_code: "130", interrupted: "true" });
  assert.deepEqual(detailOf(fail({ is_interrupt: false })), { command: "npm" });
  // is_interrupt is read on a failure only.
  assert.equal(detailOf(tool({ tool_name: "Bash", tool_input: { command: "ls" }, is_interrupt: true }))?.interrupted, undefined);
  assert.equal(parsed({ hook_event_name: "PostToolUseFailure", tool_name: "Read", is_interrupt: true }).detail, JSON.stringify({ interrupted: "true" }));
});

test("tool events: a tool name outside the pattern is stored as unknown, so the call is still counted", () => {
  for (const name of ["has space", "9lives", "-a", "a/b", "x".repeat(129), "", 7, null]) {
    const hook = tool({ tool_name: name, tool_input: { file_path: "/a" } });
    assert.equal(hook.subtype, "unknown", String(name));
    assert.equal(hook.detail, null);
  }
  assert.equal(tool({}).subtype, "unknown");
  // An MCP tool on a hyphenated server keeps its name.
  assert.equal(tool({ tool_name: "mcp__claude-in-chrome__navigate" }).subtype, "mcp__claude-in-chrome__navigate");
});

// ---- the allowlist, through the handler -----------------------------------------

// Every field of every event's input that is prompt, response, tool or transcript
// content, plus fields this receiver has no use for, each carrying MARKER.
function plantedBody(event: string): Record<string, unknown> {
  return {
    session_id: SESSION,
    hook_event_name: event,
    transcript_path: `/home/sample/.claude/projects/${MARKER}.jsonl`,
    cwd: `/home/sample/${MARKER}`,
    prompt: `${MARKER} the user's prompt`,
    last_assistant_message: `${MARKER} the model's answer`,
    tool_name: MARKER,
    tool_input: { command: `echo ${MARKER}` },
    tool_response: { stdout: MARKER },
    session_title: MARKER,
    error_details: MARKER,
    background_tasks: [{ description: MARKER }],
    session_crons: [{ prompt: MARKER }],
    agent_type: MARKER,
    // The fields each event does keep, set to plain values.
    notification_type: "permission_prompt",
    title: "Permission needed",
    message: "Claude needs your permission",
    error: "rate_limit",
    source: "startup",
    reason: "other",
    file_path: "/home/sample/settings.json",
  };
}

const DRIVER_KEY = "capsid_agent_" + "e".repeat(64);

// resolveAgent and the job binding (resolveSessionCaller) read through the D1 fake; the batch is recorded, never run,
// so every value that would reach D1 is in `writes`.
async function recordingEnv() {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  const fake = fakeD1({
    agents: [
      {
        id: "agent_hooks0000001",
        name: "sample-driver",
        kind: "driver",
        key_hash: await sha256Hex(DRIVER_KEY),
        scopes: serializeScopes(scopes),
        created_by: "github:sample",
        created_at: "2026-09-11 00:00:00",
        revoked_at: null,
        last_seen: null,
      },
    ],
  });
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      if (/^\s*SELECT/i.test(sql)) return fake.db.prepare(sql);
      return {
        bind: (...params: unknown[]) => {
          const stmt = { sql, params, run: async () => (writes.push({ sql, params }), { success: true, meta: {}, results: [] }) };
          return stmt;
        },
      };
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      writes.push(...statements.map(({ sql, params }) => ({ sql, params })));
      return statements.map((_, i) => ({ success: true, meta: {}, results: i === 0 ? [{ session_id: SESSION }] : [] }));
    },
  };
  return { env: fakeEnv({ DB: db, OPERATOR_KEY_HASH: "" }), writes };
}

function post(body: unknown): Request {
  return new Request(`https://capsid.example${OPS_HOOKS_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DRIVER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("PLANT: a prompt, a last_assistant_message, tool input or output and transcript content in a hook body never reach D1", async () => {
  let checked = 0;
  for (const event of HOOK_EVENTS) {
    const { env, writes } = await recordingEnv();
    const body = plantedBody(event);
    // StopFailure's last_assistant_message is the API error string, which is kept: it
    // is planted with no marker there, and asserted present and capped below.
    if (event === "StopFailure") body.last_assistant_message = "API Error: 429 rate limited";
    // On the tool events the tool's name is a kept field, so it is planted plain there;
    // the marker stays in the command after its first word and in the tool's output.
    if (event === "PostToolUse" || event === "PostToolUseFailure") body.tool_name = "Bash";
    const response = await handleOpsHooks(post(body), env, null, new Date("2026-09-29T12:00:00.000Z"));
    assert.equal(response.status, 200, `${event}: ${await response.clone().text()}`);
    assert.equal(await response.text(), "", "the answer must be empty so Claude Code parses no decision");
    const batched = writes.filter((w) => /agent_sessions|session_events/.test(w.sql));
    assert.ok(batched.length >= 2, `${event}: the session upsert and the event insert were not issued, so this proves nothing`);
    const everything = JSON.stringify(writes);
    assert.ok(!everything.includes(MARKER), `${event}: planted content reached a D1 statement: ${everything.slice(everything.indexOf(MARKER) - 80, everything.indexOf(MARKER) + 40)}`);
    if (event === "StopFailure") assert.ok(everything.includes("API Error: 429 rate limited"), "StopFailure's API error string was not kept");
    checked++;
  }
  assert.equal(checked, 8);
});

test("a tool event leaves last_seen alone; any other event touches it", async () => {
  const touched = async (event: Record<string, unknown>) => {
    const { env, writes } = await recordingEnv();
    const response = await handleOpsHooks(post({ session_id: SESSION, ...event }), env, null, new Date("2026-09-29T12:00:00.000Z"));
    assert.equal(response.status, 200);
    return writes.some((w) => /UPDATE agents SET last_seen/i.test(w.sql));
  };
  assert.equal(await touched({ hook_event_name: "Stop" }), true, "a Stop must touch last_seen, or this test proves nothing");
  assert.equal(await touched({ hook_event_name: "PostToolUse", tool_name: "Read" }), false);
  assert.equal(await touched({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "Exit code 1" }), false);
});

test("PLANT: content in every tool field but the kept ones never reaches D1, on both tool events", async () => {
  const kept: Record<string, string> = { PostToolUse: "/home/sample/kept.ts", PostToolUseFailure: "/home/sample/kept.ts" };
  const cases: Array<Record<string, unknown>> = [
    { tool_name: "Write", tool_input: { file_path: kept.PostToolUse, content: `${MARKER} body`, command: MARKER } },
    { tool_name: "MultiEdit", tool_input: { file_path: kept.PostToolUse, edits: [{ old_string: MARKER, new_string: MARKER }] } },
    { tool_name: "Edit", tool_input: { file_path: kept.PostToolUse, old_string: MARKER, new_string: MARKER } },
    { tool_name: "Bash", tool_input: { command: `npm test --token ${MARKER}` } },
    { tool_name: "Bash", tool_input: { command: `TOKEN=${MARKER} npm test` } },
    { tool_name: "Read", tool_input: { file_path: `/home/sample/${MARKER}` } },
    { tool_name: `bad name ${MARKER}`, tool_input: { command: MARKER } },
  ];
  let checked = 0;
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    for (const c of cases) {
      const { env, writes } = await recordingEnv();
      const body = {
        ...plantedBody(event),
        ...c,
        tool_use_id: `toolu_${MARKER}`,
        duration_ms: 4242,
        tool_response: { stdout: MARKER, content: MARKER },
        error: `Exit code 1\n${MARKER}`,
        is_interrupt: false,
      };
      const response = await handleOpsHooks(post(body), env, null, new Date("2026-09-29T12:00:00.000Z"));
      assert.equal(response.status, 200, `${event} ${String(c.tool_name)}`);
      const everything = JSON.stringify(writes);
      assert.ok(!everything.includes(MARKER), `${event} ${String(c.tool_name)}: planted content reached D1: ${everything.slice(Math.max(0, everything.indexOf(MARKER) - 80), everything.indexOf(MARKER) + 40)}`);
      assert.ok(!everything.includes("4242") && !everything.includes("toolu_"), `${event}: duration or tool_use_id reached D1`);
      checked++;
    }
  }
  assert.equal(checked, 14);
});

test("PLANT: the statements bind only named values, whatever the parsed hook holds", () => {
  // hookStatements is the only place values are bound; its parameter list is fixed.
  const hook = parsed({ hook_event_name: "Notification", notification_type: "idle_prompt" });
  const seen: unknown[][] = [];
  const db = { prepare: (sql: string) => ({ sql, bind: (...p: unknown[]) => (seen.push(p), { sql, p }) }) } as unknown as D1Database;
  const statements = hookStatements(db, "agent:sample-driver", { job_id: "job_00000000abcd", namespace: "sample" }, hook, new Date("2026-09-29T12:00:00.000Z"));
  assert.equal(statements.length, 3);
  assert.deepEqual(seen.map((p) => p.length), [15, 6, 2]);
});

test("a body over the cap is refused with 413 before it is parsed", async () => {
  const { env, writes } = await recordingEnv();
  const response = await handleOpsHooks(post({ ...plantedBody("Stop"), pad: "x".repeat(HOOK_MAX_BYTES) }), env, null);
  assert.equal(response.status, 413);
  assert.equal(writes.length, 0);
});

// ---- who may post ------------------------------------------------------------------

function rowAgent(kind: AgentKind, grants: Array<"read" | "write">): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = grants;
  const row = { id: "agent_x", name: `sample-${kind}`, kind, key_hash: "h", scopes: serializeScopes(scopes), created_by: "github:sample", created_at: "2026-09-11 00:00:00", revoked_at: null, last_seen: null, job_id: null } as AgentRow;
  return { id: row.id, name: row.name, kind, actor: `agent:${row.name}`, scopes, admin: false, row };
}

test("a driver, a runner and the admin may post hooks; a read-only key, a cron or seat agent and a legacy read key may not", () => {
  assert.equal(sessionCallerRefusal(rowAgent("driver", ["read", "write"])), null);
  assert.equal(sessionCallerRefusal(rowAgent("session", ["read", "write"])), null);
  assert.equal(sessionCallerRefusal(adminAgentForEmail("admin@example.com")), null);
  assert.equal(sessionCallerRefusal(legacyAgent("write", "opkey:abc")), null);
  assert.match(sessionCallerRefusal(rowAgent("driver", ["read"])) ?? "", /requires the write grant/);
  assert.match(sessionCallerRefusal(rowAgent("cron", ["read", "write"])) ?? "", /is not a driver\./);
  assert.match(sessionCallerRefusal(rowAgent("seat", ["read", "write"])) ?? "", /is not a driver\./);
  assert.match(sessionCallerRefusal(legacyAgent("read", "opkey:def")) ?? "", /is not a driver\./);
});

// ---- the feed's incidents ------------------------------------------------------------

const NOW = new Date("2026-09-29T12:00:00.000Z");
function sessionRow(over: Partial<SessionFeedRow>): SessionFeedRow {
  return {
    session_id: SESSION,
    agent: "agent:sample-driver",
    job_id: "job_00000000abcd",
    namespace: "sample",
    source: "startup",
    model: null,
    permission_mode: null,
    started_at: "2026-09-29T11:00:00.000Z",
    last_event_at: "2026-09-29T11:59:00.000Z",
    last_event: "Stop",
    last_notification_type: null,
    needs_input: 0,
    last_failure: null,
    ...over,
  };
}

test("a session is an incident when it stopped on a failure a person must act on, or has waited on input over ten minutes", () => {
  assert.equal(opsSessionFrom(sessionRow({}), NOW).incident, null);
  for (const failure of ["rate_limit", "billing_error", "authentication_failed", "account_on_hold", "oauth_org_not_allowed"]) {
    assert.equal(opsSessionFrom(sessionRow({ last_failure: failure }), NOW).incident, "failure", failure);
  }
  // A failure Claude Code retries on its own is shown, not an incident.
  const overloaded = opsSessionFrom(sessionRow({ last_failure: "overloaded" }), NOW);
  assert.equal(overloaded.incident, null);
  assert.equal(overloaded.last_failure, "overloaded");
  const waiting = (at: string) => opsSessionFrom(sessionRow({ needs_input: 1, last_event: "Notification", last_notification_type: "permission_prompt", last_event_at: at }), NOW);
  assert.equal(waiting("2026-09-29T11:49:00.000Z").incident, "waiting");
  assert.equal(waiting("2026-09-29T11:55:00.000Z").incident, null);
  assert.equal(waiting("2026-09-29T11:55:00.000Z").needs_input, true);
});
