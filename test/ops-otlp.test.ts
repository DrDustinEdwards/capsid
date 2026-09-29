import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyAgent, type Agent } from "../src/agents.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import {
  OTLP_MAX_BYTES,
  OTLP_METRICS_PATH,
  aggregate,
  jobForSession,
  parseLogs,
  parseMetrics,
  pointValue,
  readOtlpBody,
  recordExport,
} from "../src/ops-otlp.ts";
import { sessionCallerRefusal, type SessionCaller } from "../src/ops-session-auth.ts";

// The OTLP receiver's parsing and writing, without a database: what is read out of an
// export, how points become one write per series, and what reaches D1. The routes,
// their auth and the upsert itself are driven through the Worker in
// test-integration/ops-otlp.test.ts.

const SESSION = "0b8e6a52-sample-session";
const JOB = "job_0123456789ab";

type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });

function sumMetric(name: string, temporality: number, points: Array<Record<string, unknown>>) {
  return { name, unit: "1", sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints: points } };
}

function exportOf(metrics: unknown[], resource: Attr[] = [s("session.id", SESSION), s("service.name", "claude-code")]) {
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope: { name: "com.anthropic.claude_code" }, metrics }] }] };
}

// A D1 stand-in that records every bound value, for the one question these tests ask
// of the database: what did the receiver send it.
// `bound` is what agent_sessions already holds. The batch answers each RETURNING
// statement with its row, as a landed write does.
function recordingDb(bound: Array<{ session_id: string; agent: string; job_id: string | null }> = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = {
            sql,
            params,
            all: async () => {
              statements.push({ sql, params });
              return { results: /FROM agent_sessions/.test(sql) ? bound : [] };
            },
          };
          return stmt;
        },
      };
    },
    batch: async (stmts: Array<{ sql: string; params: unknown[] }>) => {
      for (const st of stmts) statements.push({ sql: st.sql, params: st.params });
      return stmts.map((st) => ({ results: /RETURNING/.test(st.sql) ? [{ session_id: st.params[0] }] : [] }));
    },
  } as unknown as D1Database;
  const writes = () => statements.filter((st) => /^\s*INSERT INTO session_usage/.test(st.sql));
  return { db, statements, writes };
}

function driverAgent(): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  return {
    id: "agent_sampledrv01",
    name: "sample-driver",
    kind: "driver",
    actor: "agent:sample-driver",
    scopes,
    admin: false,
    row: {
      id: "agent_sampledrv01",
      name: "sample-driver",
      kind: "driver",
      key_hash: "0".repeat(64),
      scopes: "{}",
      created_by: "github:sample",
      created_at: "2026-09-01 00:00:00",
      revoked_at: null,
      last_seen: null,
    },
  };
}

const caller = (job_id: string | null = JOB): SessionCaller => ({
  agent: driverAgent(),
  job_id,
  namespace: job_id ? "sample" : null,
  touch: async () => {},
});

test("the metrics path is the one Claude Code's exporter appends to the endpoint", () => {
  assert.equal(OTLP_METRICS_PATH, "/ops/otlp/v1/metrics");
});

// delta and cumulative

test("delta points of one series are summed into one add", async () => {
  const parsed = parseMetrics(
    exportOf([
      sumMetric("claude_code.cost.usage", 1, [
        { attributes: [s("model", "claude-sample-1")], asDouble: 0.25, timeUnixNano: "1" },
        { attributes: [s("model", "claude-sample-1")], asDouble: 0.5, timeUnixNano: "2" },
      ]),
    ])
  );
  assert.equal(parsed.rejected, 0);
  const writes = aggregate(parsed.points);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, "add");
  assert.equal(writes[0].value, 0.75);

  const { db, writes: sent } = recordingDb();
  const response = await recordExport(db, caller(), parsed, new Date("2026-09-29T00:00:00.000Z"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal(sent().length, 1);
  assert.match(sent()[0].sql, /value = session_usage\.value \+ excluded\.value/);
  assert.deepEqual(sent()[0].params.slice(0, 6), [SESSION, JOB, "claude_code.cost.usage", "", "claude-sample-1", 0.75]);
});

test("cumulative points replace: the newest point of a series is the total", async () => {
  const parsed = parseMetrics(
    exportOf([
      sumMetric("claude_code.token.usage", 2, [
        { attributes: [s("type", "input"), s("model", "claude-sample-1")], asInt: "900", timeUnixNano: "20" },
        { attributes: [s("type", "input"), s("model", "claude-sample-1")], asInt: "400", timeUnixNano: "10" },
      ]),
    ])
  );
  const writes = aggregate(parsed.points);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, "replace");
  assert.equal(writes[0].value, 900, "the older point won");

  const { db, writes: sent } = recordingDb();
  await recordExport(db, caller(), parsed, new Date());
  assert.match(sent()[0].sql, /value = excluded\.value,/);
  assert.doesNotMatch(sent()[0].sql, /session_usage\.value \+/);
});

test("asInt may be a decimal string, and a value that is not a non-negative number is rejected", () => {
  assert.equal(pointValue({ asInt: "12345678901" }), 12345678901);
  assert.equal(pointValue({ asInt: 7 }), 7);
  assert.equal(pointValue({ asDouble: 1.5 }), 1.5);
  assert.equal(pointValue({ asInt: "12.5" }), null);
  assert.equal(pointValue({ asInt: "-3" }), null);
  assert.equal(pointValue({ asDouble: Number.NaN }), null);
  assert.equal(pointValue({}), null);
});

test("a point that cannot be read is dropped and reported as partialSuccess", async () => {
  const parsed = parseMetrics(
    exportOf(
      [
        sumMetric("claude_code.token.usage", 1, [
          { attributes: [s("type", "output")], asInt: "10" },
          // No session.id on the point or the resource.
          { attributes: [s("type", "output"), s("session.id", "")], asInt: "10" },
          { attributes: [s("type", "not-a-type"), s("session.id", SESSION)], asInt: "10" },
        ]),
      ],
      []
    )
  );
  assert.equal(parsed.points.length, 0);
  assert.equal(parsed.rejected, 3);
  const { db } = recordingDb();
  const body = (await (await recordExport(db, caller(), parsed, new Date())).json()) as { partialSuccess?: { rejectedDataPoints: number; errorMessage: string } };
  assert.equal(body.partialSuccess?.rejectedDataPoints, 3);
  assert.ok(body.partialSuccess?.errorMessage);
});

test("metrics that are not claude_code.* ones this receiver keeps are ignored, not rejected", async () => {
  const parsed = parseMetrics(
    exportOf([
      sumMetric("http.client.request.count", 1, [{ asInt: "5" }]),
      sumMetric("claude_code.code_edit_tool.decision", 1, [{ asInt: "1" }]),
      sumMetric("claude_code.session.count", 1, [{ asInt: "1" }]),
    ])
  );
  assert.equal(parsed.points.length, 0);
  assert.equal(parsed.rejected, 0);
  const { db, writes } = recordingDb();
  const response = await recordExport(db, caller(), parsed, new Date());
  assert.deepEqual(await response.json(), {});
  assert.equal(writes().length, 0);
});

// the body

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("a gzip body is decompressed, and one over the cap after decompression is 413", async () => {
  const payload = JSON.stringify(exportOf([sumMetric("claude_code.commit.count", 1, [{ asInt: "2" }])]));
  const ok = await readOtlpBody(
    new Request("https://capsid.example/ops/otlp/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: await gzip(payload),
    })
  );
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.text, payload);
  assert.equal(parseMetrics(JSON.parse(ok.ok ? ok.text : "{}")).points[0]?.value, 2);

  // Compresses to a few KB and expands past the cap.
  const bomb = await gzip(" ".repeat(OTLP_MAX_BYTES + 1024));
  assert.ok(bomb.byteLength < OTLP_MAX_BYTES, "the fixture is not a small compressed body");
  const refused = await readOtlpBody(
    new Request("https://capsid.example/ops/otlp/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: bomb,
    })
  );
  assert.ok(!refused.ok);
  assert.equal(!refused.ok && refused.response.status, 413);
});

test("protobuf and unknown encodings are refused with 415", async () => {
  const proto = await readOtlpBody(
    new Request("https://capsid.example/ops/otlp/v1/metrics", { method: "POST", headers: { "Content-Type": "application/x-protobuf" }, body: "x" })
  );
  assert.equal(!proto.ok && proto.response.status, 415);
  const br = await readOtlpBody(
    new Request("https://capsid.example/ops/otlp/v1/metrics", { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "br" }, body: "x" })
  );
  assert.equal(!br.ok && br.response.status, 415);
});

// what reaches D1

test("PLANT: a content-bearing attribute or log body never reaches D1", async () => {
  const PLANT = "PLANTED-CONTENT-8f3a";
  const metrics = parseMetrics(
    exportOf(
      [
        sumMetric("claude_code.token.usage", 1, [
          {
            attributes: [s("type", "input"), s("model", "claude-sample-1"), s("prompt", `${PLANT} prompt`), s("tool_input", `${PLANT} tool`)],
            asInt: "10",
          },
        ]),
      ],
      [s("session.id", SESSION), s("user.email", `${PLANT}@example.com`), s("organization.id", PLANT), s("terminal.type", PLANT)]
    )
  );
  const logs = parseLogs({
    resourceLogs: [
      {
        resource: { attributes: [s("session.id", SESSION), s("user.email", `${PLANT}@example.com`)] },
        scopeLogs: [
          {
            logRecords: [
              { body: { stringValue: `${PLANT} a user prompt` }, attributes: [s("event.name", "user_prompt"), s("prompt", PLANT)] },
              { body: { stringValue: `${PLANT} tool result` }, attributes: [s("event.name", "tool_result"), s("tool_output", PLANT)] },
              {
                body: { stringValue: "claude_code.api_error" },
                attributes: [s("event.name", "api_error"), s("status_code", "529"), s("error", `${PLANT} overloaded`), s("model", "claude-sample-1")],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(metrics.points.length, 1, "the fixture's metric point was not kept, so this test proves nothing");
  assert.equal(logs.points.length, 1, "the api_error record was not counted, so this test proves nothing");
  const { db, statements, writes } = recordingDb();
  await recordExport(db, caller(), metrics, new Date());
  await recordExport(db, caller(), logs, new Date());
  assert.equal(writes().length, 2);
  const sent = JSON.stringify(statements.map((st) => st.params));
  assert.ok(!sent.includes(PLANT), `content reached D1: ${sent}`);
  // What did reach it: the status, not the error text.
  assert.deepEqual(writes()[1].params.slice(0, 6), [SESSION, JOB, "claude_code.api_error", "529", "claude-sample-1", 1]);
});

// the job

test("a session keeps the job it was first bound to; the capsid.job_id attribute never picks one", async () => {
  assert.deepEqual(jobForSession(caller(JOB), undefined, null), { job: JOB, mismatch: false });
  assert.deepEqual(jobForSession(caller(JOB), "job_aaaaaaaaaaaa", null), { job: "job_aaaaaaaaaaaa", mismatch: false });
  assert.deepEqual(jobForSession(caller(null), undefined, JOB), { job: null, mismatch: true });
  assert.deepEqual(jobForSession(caller(JOB), undefined, JOB), { job: JOB, mismatch: false });

  // Through recordExport: the attribute names another job, the caller's binding wins.
  const parsed = parseMetrics(
    exportOf([sumMetric("claude_code.active_time.total", 1, [{ attributes: [s("type", "cli"), s("capsid.job_id", "job_ffffffffffff")], asDouble: 30 }])])
  );
  const { db, writes } = recordingDb();
  const body = (await (await recordExport(db, caller(JOB), parsed, new Date())).json()) as { partialSuccess?: { errorMessage: string } };
  assert.equal(writes()[0].params[1], JOB);
  assert.match(body.partialSuccess?.errorMessage ?? "", /capsid\.job_id other than the job this caller is bound to/);
});

// the caller

test("only a driver, a runner key or the admin, holding write, may report on a session", () => {
  assert.equal(sessionCallerRefusal(driverAgent()), null);
  assert.equal(sessionCallerRefusal(legacyAgent("write", "opkey:sample")), null, "the admin is refused");
  assert.ok(sessionCallerRefusal(legacyAgent("read", "opkey:sample-ro")), "a read-only operator key is admitted");
  const readOnlyDriver = driverAgent();
  readOnlyDriver.scopes.grants = ["read"];
  assert.match(sessionCallerRefusal(readOnlyDriver) ?? "", /write grant/);
  const seat = { ...driverAgent(), kind: "seat" as const };
  assert.match(sessionCallerRefusal(seat) ?? "", /not a driver or a runner/);
});

// whose session it is

test("the ownership condition is bound: a claim for a new session, then upserts only where agent_sessions names this caller", async () => {
  const parsed = parseMetrics(exportOf([sumMetric("claude_code.commit.count", 1, [{ asInt: "1" }])]));
  const { db, statements, writes } = recordingDb();
  const response = await recordExport(db, caller(), parsed, new Date("2026-09-29T00:00:00.000Z"));
  assert.deepEqual(await response.json(), {});
  const batched = statements.filter((st) => /^\s*INSERT/.test(st.sql));
  assert.equal(batched.length, 2, "the claim and the upsert were not both sent in one batch");
  // The claim first, so the upsert's condition finds it in the same batch.
  assert.match(batched[0].sql, /INSERT INTO agent_sessions[\s\S]*ON CONFLICT\(session_id\) DO NOTHING/);
  assert.deepEqual(batched[0].params.slice(0, 4), [SESSION, "agent:sample-driver", JOB, "sample"]);
  assert.match(writes()[0].sql, /WHERE EXISTS \(SELECT 1 FROM agent_sessions WHERE session_id = \?1 AND agent = \?8\)/);
  assert.equal(writes()[0].params[7], "agent:sample-driver", "the caller is not what the ownership condition compares against");
});

test("points for a session another key reported first are rejected and counted, and nothing is written for them", async () => {
  const parsed = parseMetrics(exportOf([sumMetric("claude_code.commit.count", 1, [{ asInt: "1" }, { asInt: "2" }])]));
  const { db, writes } = recordingDb([{ session_id: SESSION, agent: "agent:other-driver", job_id: "job_aaaaaaaaaaaa" }]);
  const body = (await (await recordExport(db, caller(), parsed, new Date())).json()) as { partialSuccess?: { rejectedDataPoints: number; errorMessage: string } };
  assert.equal(writes().length, 0);
  assert.equal(body.partialSuccess?.rejectedDataPoints, 2);
  assert.match(body.partialSuccess?.errorMessage ?? "", /first reported by another key/);
});
