import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONDITION,
  isRunCondition,
  RUN_CONDITIONS,
  type RunCondition,
} from "../src/improve-schema.ts";
import { improveRunManual, openRuns } from "../src/improve-run.ts";
import { tickRuns } from "../src/improve/tick.ts";
import { finalizeRun } from "../src/improve/finalize.ts";
import type { RunRow } from "../src/improve-state.ts";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IMPROVE_RUN_DEFAULTS, sseMessage } from "./improve-fakes.ts";
import { anchorChecksum, parseScoresDoc } from "../src/improve-scores.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, withFetch } from "./fakes.ts";
import { seedScoresDoc } from "./seed-scores.ts";

// improve_runs.condition, from the arc's third ruling.
//
// The column exists so an ablation is a query rather than an archaeology exercise.
// That gives it three separate obligations, and this file asserts each: the
// vocabulary is one list rather than two, the value is recorded on the row AND in
// the audit rows, and each value actually switches something off. A condition
// recorded on a run that behaved identically to `full` is a label that lies, which
// is worse than no column at all.

const SCORES = seedScoresDoc("capsid");
const NOW = new Date("2026-09-05T08:05:00Z");
// A run started just before NOW, so the age limit does not end it first.
const FRESH = { started: "2026-09-05 08:00:00", advanced_at: "2026-09-05 08:00:00" };

// ---- the column and the vocabulary ------------------------------------------

test("isRunCondition admits exactly the three and nothing else", () => {
  for (const value of RUN_CONDITIONS) assert.equal(isRunCondition(value), true, `${value} was rejected`);
  for (const value of ["", "FULL", "no memory", "nomemory", "none", "full ", "no-transfers"]) {
    assert.equal(isRunCondition(value), false, `'${value}' was admitted`);
  }
});

// ---- set and logged on every run --------------------------------------------

async function harness(kvSeed: Record<string, string> = {}) {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: "improve/scores.md", title: "s", body: SCORES, type: "reference" }],
    namespaces: [{ namespace: "capsid", repos: JSON.stringify([{ repo: "o/r", label: "primary" }]) }],
  });
  const kv = fakeKv({
    seed: {
      improve_mode: "api",
      "improve:anchor:capsid": await anchorChecksum(parseScoresDoc("capsid", SCORES)),
      ...kvSeed,
    },
    seedToken: true,
  });
  const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, HOLDOUT: fakeR2().bucket, MEDIA: fakeR2().bucket, ANTHROPIC_API_KEY: "sk-test" });
  return { d1, kv, env };
}

const auditRows = (recorded: Array<{ sql: string; params: unknown[] }>) =>
  recorded
    .filter((r) => r.sql.includes("INSERT INTO audit_log"))
    .map((r) => ({ action: r.params[1] as string, params: JSON.parse(String(r.params[4] ?? r.params[3])) as Record<string, unknown> }));

test("a run opened with no condition is recorded as full", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    await openRuns(env, NOW, "capsid");
    assert.equal(d1.rows.improve_runs.length, 1, "no run was opened");
    assert.equal(d1.rows.improve_runs[0].condition, "full");
  });
});

test("EVERY CONDITION IS RECORDED ON THE ROW as asked for", async () => {
  for (const condition of RUN_CONDITIONS) {
    await withFetch({}, async () => {
      const { d1, env } = await harness();
      await openRuns(env, NOW, "capsid", condition);
      assert.equal(d1.rows.improve_runs[0].condition, condition, `${condition} was not recorded`);
    });
  }
});

test("THE CONDITION IS IN THE OPENING AUDIT ROW, not only on the row it describes", async () => {
  // improve_runs is pruned by nothing, but audit_log is the one table where a
  // single query answers "what did the loop do, and under what condition".
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    await openRuns(env, NOW, "capsid", "no-memory");
    const opened = auditRows(d1.recorded).find((a) => a.action === "improve-run-opened");
    assert.ok(opened, "no improve-run-opened audit row was written");
    assert.equal(opened.params.condition, "no-memory");
  });
});

test("the FINISHING audit row and the run summary both carry it, so one query covers a run's whole life", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    d1.rows.improve_runs.push({ ...IMPROVE_RUN_DEFAULTS, status: "finalizing", condition: "no-memory", ...FRESH });
    await finalizeRun(env, d1.rows.improve_runs[0] as unknown as RunRow, NOW);
    const finished = auditRows(d1.recorded).find((a) => a.action === "improve-run-finished");
    assert.ok(finished, "no improve-run-finished audit row was written");
    assert.equal(finished.params.condition, "no-memory");
    const summary = d1.recorded.find((r) => r.sql.includes("INSERT INTO documents") && String(r.params[1]).endsWith("run-summary.md"));
    assert.ok(summary, "no run summary document was written");
    assert.match(String(summary.params[3]), /^- condition: no-memory$/m);
  });
});

// ---- each condition switches something off ----------------------------------

// One attempt under a condition, returning which inputs the attempt read. The model
// proposes nothing, so the attempt ends right after the reads under test.
async function attemptReads(condition: string) {
  const route = {
    "POST /v1/messages": {
      contentType: "text/event-stream",
      text: sseMessage(JSON.stringify({ summary: "s", reasoning: "r", files: [] })),
    },
  };
  let reads: string[] = [];
  await withFetch(route, async (calls) => {
    const { d1, env } = await harness();
    d1.rows.improve_runs.push({ ...IMPROVE_RUN_DEFAULTS, status: "attempting", condition, ...FRESH });
    const outcomes = await tickRuns(env, NOW);
    assert.match(outcomes[0]?.note ?? "", /proposed no file changes/, `the attempt under ${condition} did not reach the model`);
    assert.equal(calls.filter((c) => c.path === "/v1/messages").length, 1);
    reads = d1.reads.map((r) => r.sql);
  });
  return {
    lineage: reads.some((sql) => /FROM improve_attempts WHERE namespace = \?1 ORDER BY ts DESC/.test(sql)),
    skills: reads.some((sql) => /FROM improve_skills s/.test(sql)),
  };
}

test("'no-memory' WITHHOLDS LINEAGE HISTORY from base selection", async () => {
  // The ablation is only real if the input is actually withheld. A condition that
  // reached selectBase with the full history would be a label that lies.
  assert.equal((await attemptReads("full")).lineage, true, "a full run did not read lineage, so this test proves nothing");
  assert.equal((await attemptReads("no-memory")).lineage, false, "'no-memory' still reads lineage history");
});

test("'no-transfer' OFFERS NO cross-project skill", async () => {
  assert.equal((await attemptReads("full")).skills, true, "a full run did not look for a skill, so this test proves nothing");
  assert.equal((await attemptReads("no-transfer")).skills, false, "'no-transfer' still looks for a transferred skill");
});

// scanner-rule: the improve arc's condition ruling (capsid/decisions.md), a condition that
// changes nothing is a label that lies. A fourth value cannot be exercised by a test
// written before it exists, so the source is what is checked.

// ---- the tool surface -------------------------------------------------------

test("AN UNRECOGNISED CONDITION IS REFUSED, not silently defaulted to full", async () => {
  await withFetch({}, async () => {
    const { d1, env } = await harness();
    await assert.rejects(
      () => improveRunManual(env, NOW, { namespace: "capsid", dryRun: false, condition: "no-lineage" }),
      /unknown condition 'no-lineage'/
    );
    // And nothing was opened, so a refused condition cannot half-start a run.
    assert.deepEqual(d1.rows.improve_runs, []);
  });
});

test("the refusal names every valid condition", async () => {
  await withFetch({}, async () => {
    const { env } = await harness();
    await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true, condition: "bogus" }).then(
      () => assert.fail("a bogus condition was accepted"),
      (err: Error) => {
        for (const condition of RUN_CONDITIONS) {
          assert.match(err.message, new RegExp(condition), `the refusal does not name ${condition}`);
        }
      }
    );
  });
});

test("the manual result reports the condition it ran under, including on a dry run", async () => {
  await withFetch({}, async () => {
    const { env } = await harness();
    const dry = await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true, condition: "no-transfer" });
    assert.equal(dry.condition, "no-transfer");
    assert.equal(dry.dry_run, true);
    const dflt = await improveRunManual(env, NOW, { namespace: "capsid", dryRun: true });
    assert.equal(dflt.condition, DEFAULT_CONDITION);
  });
});

test("the improve_run tool serves condition, describes each value, and passes it through", async () => {
  await withFetch({}, async () => {
    const { env } = await harness();
    const server = buildServer(env, adminAgent("DrDustinEdwards"));
    const client = new Client({ name: "condition-tool", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const description = String((tools.find((t) => t.name === "improve_run")?.inputSchema.properties?.condition as { description?: string } | undefined)?.description ?? "");
    for (const condition of RUN_CONDITIONS) assert.match(description, new RegExp(condition), `the condition argument does not describe ${condition}`);
    const result = (await client.callTool({
      name: "improve_run",
      arguments: { namespace: "capsid", dry_run: true, condition: "no-transfer" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    await client.close();
    assert.notEqual(result.isError, true, result.content[0]?.text);
    assert.equal(JSON.parse(result.content[0].text).condition, "no-transfer", "the tool dropped the condition");
  });
});

// A type-level assertion: RunRow.condition is the union, not a bare string, so a typo
// in a call site is a compile error rather than a row nobody notices. The two
// assignments are checked by npm run check:test.
const TYPED: RunCondition = DEFAULT_CONDITION;
const ROW_CONDITION: RunCondition = ({ condition: DEFAULT_CONDITION } as Pick<RunRow, "condition">).condition;
test("the condition is a union type, not a bare string", () => {
  assert.equal(TYPED, "full");
  assert.equal(ROW_CONDITION, "full");
});
