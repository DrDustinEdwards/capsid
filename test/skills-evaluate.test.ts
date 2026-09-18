import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CADENCE_KEY,
  DEFAULT_CADENCE_DAYS,
  LAST_CYCLE_KEY,
  MIN_CADENCE_DAYS,
  cadenceDays,
  cycleDue,
  evaluationStatement,
  judgeEdit,
  mergeProposals,
  rejectedEdits,
  runEvaluationCycle,
} from "../src/skills-evaluate.ts";
import { tickRuns } from "../src/improve/tick.ts";
import { fakeD1, fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// GROUPS 4, 5 AND 6: the cadence that produces evidence, the gate that accepts an
// edit, and the duplicate detector. The deciding rules live in ./skills-lifecycle and
// are tested there; this is the half that touches rows and the clock.

const NOW = new Date("2026-09-12T00:00:00Z");

// Two non-positive evaluations at version 1, which retire a live skill.
const negative = (skill: string, day: string) => ({
  skill, version: 1, namespace: "capsid", probe_set_version: "p1", delta: -0.1, runs: 5, verdict: "negative", evaluated_at: `2026-09-${day}`,
});

const DISPATCH_ROUTES = {
  "GET /repos/owner/repo": { body: { default_branch: "main" } },
  "POST /repos/owner/repo/actions/workflows/improve-score.yml/dispatches": { status: 204 },
};

function cycleEnv() {
  const fake = fakeD1({});
  const kv = fakeKv({ seedToken: true });
  return { fake, kv, env: fakeEnv({ DB: fake.db, APP_KV: kv.kv, GITHUB_APP_CLIENT_ID: "x", GITHUB_APP_PRIVATE_KEY: "y" }) };
}

function env(kv: Record<string, string> = {}, opts: Parameters<typeof fakeD1>[0] = {}) {
  const fake = fakeD1(opts);
  return { fake, env: fakeEnv({ DB: fake.db, APP_KV: fakeKv({ seed: kv }).kv }) };
}

// ---- group 4: the cadence --------------------------------------------------------

test("the cadence defaults to a fortnight and is KV-configurable", async () => {
  assert.equal(DEFAULT_CADENCE_DAYS, 14);
  assert.equal(await cadenceDays(env().env), 14);
  assert.equal(await cadenceDays(env({ [CADENCE_KEY]: "7" }).env), 7);
  assert.equal(await cadenceDays(env({ [CADENCE_KEY]: "30" }).env), 30);
});

test("an unusable cadence falls back rather than being obeyed", async () => {
  // A cadence of zero would run the cycle on every five-minute tick, which is the one
  // setting that turns a bounded cost into an unbounded one.
  for (const bad of ["0", "-3", "banana", "", "0.5"]) {
    assert.equal(await cadenceDays(env({ [CADENCE_KEY]: bad }).env), DEFAULT_CADENCE_DAYS, `${bad} must fall back`);
  }
  assert.equal(MIN_CADENCE_DAYS, 1);
});

test("an unreadable store falls back to the default rather than failing the tick", async () => {
  const fake = fakeD1({});
  const broken = fakeEnv({ DB: fake.db, APP_KV: fakeKv({ failGet: true }).kv });
  assert.equal(await cadenceDays(broken), DEFAULT_CADENCE_DAYS);
});

test("the cycle is due when nothing has run, and not before the cadence elapses", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  assert.equal(cycleDue(null, 14, now).due, true);
  assert.equal(cycleDue("2026-09-11T00:00:00Z", 14, now).due, false, "one day of fourteen");
  assert.equal(cycleDue("2026-08-29T00:00:00Z", 14, now).due, true, "exactly fourteen days is due");
  assert.equal(cycleDue("2026-08-28T00:00:00Z", 14, now).due, true);
});

test("a corrupt last-cycle stamp runs the cycle rather than blocking it forever", () => {
  // The cost of one extra cycle is CI minutes. The cost of never running again is a
  // lifecycle that silently stops moving, which nothing would report.
  const verdict = cycleDue("not a date", 14, new Date("2026-09-12T00:00:00Z"));
  assert.equal(verdict.due, true);
  assert.match(verdict.reason, /does not parse/);
});

test("the tick runs the evaluation cycle, and the cycle stamps its own last-run key", async () => {
  await withFetch({}, async () => {
    const { env: e, kv } = cycleEnv();
    await tickRuns(e, NOW);
    assert.equal(kv.store.get(LAST_CYCLE_KEY), NOW.toISOString(), "the tick did not run the cycle");
    const again = await runEvaluationCycle(e, new Date(NOW.getTime() + 60_000));
    assert.equal(again.ran, false, "the cycle must gate on its own stamp, not run on every tick");
  });
});

test("a throwing cycle does not stop the tick", async () => {
  await withFetch({}, async () => {
    const { env: e, kv, fake } = cycleEnv();
    const prepare = fake.db.prepare.bind(fake.db);
    (fake.db as { prepare: (sql: string) => D1PreparedStatement }).prepare = (sql: string) => {
      if (/FROM improve_skills WHERE status IN/i.test(sql)) throw new Error("planted cycle failure");
      return prepare(sql);
    };
    await tickRuns(e, NOW);
    assert.equal(kv.store.has(LAST_CYCLE_KEY), false, "the planted failure did not reach the cycle");
  });
});

test("transitions are still applied, and the cycle dispatches nothing at all", async () => {
  // Was: "transitions are applied before the next round is dispatched". That ordering
  // mattered while the cycle ended by dispatching a probe per surviving skill. Option C
  // (2026-09-16) dropped the probe, so there is no second half to order against and the
  // property worth holding is the stronger one: the transition half still works, and
  // neither skill produces a dispatch.
  await withFetch(DISPATCH_ROUTES, async (calls) => {
    const { env: e, fake } = cycleEnv();
    fake.rows.improve_skills.push(
      { id: "fading", status: "live", version: 1, source_namespace: "capsid" },
      { id: "fresh", status: "candidate", version: 1, source_namespace: "capsid" }
    );
    fake.rows.skill_evaluations.push(negative("fading", "01"), negative("fading", "02"));
    const report = await runEvaluationCycle(e, NOW);
    assert.deepEqual(report.transitions.map((t) => [t.skill, t.to]), [["fading", "retired"]]);
    assert.deepEqual(
      calls.filter((c) => c.method === "POST").map((c) => c.path),
      [],
      "the cycle dispatched something. Scheduled probing was dropped; a POST from here is the dead probe returning."
    );
  });
});

test("an evaluation row stores the verdict derived at write time", () => {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return {} as D1PreparedStatement;
      },
    }),
  } as unknown as D1Database;

  evaluationStatement(db, { skill: "s1", version: 1, namespace: "capsid", probeSetVersion: "p1", delta: 0.2, runs: 5 });
  evaluationStatement(db, { skill: "s1", version: 1, namespace: "capsid", probeSetVersion: "p1", delta: 0, runs: 5 });
  evaluationStatement(db, { skill: "s1", version: 1, namespace: "capsid", probeSetVersion: "p1", delta: -0.2, runs: 5 });
  assert.deepEqual(recorded.map((r) => r.params[6]), ["positive", "neutral", "negative"]);
  // Stored rather than derived on read, so a later change to the threshold cannot
  // restate old rows as something they were not.
  assert.match(recorded[0].sql, /INSERT INTO skill_evaluations/);
});

// ---- group 5: the edit gate ------------------------------------------------------

const L2 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

function editDb() {
  const recorded: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return {} as D1PreparedStatement;
      },
    }),
  } as unknown as D1Database;
  return { recorded, db };
}

test("an out-of-bounds edit is refused before anything is measured, and still recorded", () => {
  const { recorded, db } = editDb();
  const ops = [1, 2, 3, 4, 5].map((line) => ({ op: "replace" as const, line, text: "x" }));
  const verdict = judgeEdit(db, { id: "s1", version: 1, l2: L2 }, ops, { deltaBefore: 0.1, deltaAfter: 0.9 });
  assert.equal(verdict.accepted, false, "a huge measured gain must not buy a way past the bound");
  assert.equal(recorded.length, 1, "a rejection is recorded, because it is what the next optimizer reads");
  assert.equal(recorded[0].params[4], 0, "accepted = 0");
});

test("an unmeasured edit is refused", () => {
  const { db } = editDb();
  const verdict = judgeEdit(db, { id: "s1", version: 1, l2: L2 }, [{ op: "replace", line: 1, text: "x" }], null);
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reason, /not measured/);
});

test("a tie is rejected and recorded with its reason", () => {
  const { recorded, db } = editDb();
  const verdict = judgeEdit(db, { id: "s1", version: 1, l2: L2 }, [{ op: "replace", line: 1, text: "x" }], {
    deltaBefore: 0.1,
    deltaAfter: 0.1,
  });
  assert.equal(verdict.accepted, false);
  assert.match(String(recorded[0].params[5]), /tie is a rejection/);
});

test("an accepted edit bumps the version, guarded on the version it read", () => {
  const { recorded, db } = editDb();
  const verdict = judgeEdit(db, { id: "s1", version: 3, l2: L2 }, [{ op: "replace", line: 1, text: "x" }], {
    deltaBefore: 0.1,
    deltaAfter: 0.3,
  });
  assert.equal(verdict.accepted, true);
  assert.equal(recorded.length, 2, "the edit row and the version bump");
  assert.equal(recorded[0].params[4], 1, "accepted = 1");
  assert.equal(recorded[0].params[2], 4, "to_version");
  assert.match(recorded[1].sql, /UPDATE improve_skills SET version = \?2 WHERE id = \?1 AND version = \?3/);
  assert.deepEqual(recorded[1].params, ["s1", 4, 3], "the bump is keyed on the version it read");
});

test("every proposal is recorded, accepted or not", () => {
  // skill_edits exists so the next optimizer sees what was already refused. A
  // refusal that wrote nothing would be a proposal made again next cycle.
  for (const measured of [null, { deltaBefore: 0.1, deltaAfter: 0.1 }, { deltaBefore: 0.1, deltaAfter: 0.4 }]) {
    const { recorded, db } = editDb();
    judgeEdit(db, { id: "s1", version: 1, l2: L2 }, [{ op: "replace", line: 2, text: "y" }], measured);
    assert.ok(recorded.length >= 1, "every outcome writes a skill_edits row");
    assert.match(recorded[0].sql, /INSERT INTO skill_edits/);
  }
});

test("rejected edits come back newest first and bounded", async () => {
  const { fake, env: e } = env();
  fake.rows.skill_edits.push(
    { skill: "s1", from_version: 1, to_version: 2, ops: "[]", accepted: 0, reason: "older", evaluated_at: "2026-09-01" },
    { skill: "s1", from_version: 1, to_version: 2, ops: "[]", accepted: 0, reason: "newer", evaluated_at: "2026-09-09" },
    { skill: "s1", from_version: 1, to_version: 2, ops: "[]", accepted: 1, reason: "accepted one", evaluated_at: "2026-09-10" }
  );
  const rejected = await rejectedEdits(e, "s1");
  assert.deepEqual(rejected.map((r) => r.reason), ["newer", "older"], "accepted edits are not negative feedback");
});

// ---- group 6: merge proposals ----------------------------------------------------

test("two live near-duplicates with overlapping triggers are proposed, and others are not", async () => {
  const body = Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n");
  const { fake, env: e } = env(
    {},
    {
      documents: [
        { namespace: "capsid", path: "improve/skills/a.md", title: "a", body },
        { namespace: "capsid", path: "improve/skills/b.md", title: "b", body: body.replace("step 19", "step nineteen") },
        { namespace: "capsid", path: "improve/skills/c.md", title: "c", body: "something entirely different" },
      ],
    }
  );
  fake.rows.improve_skills.push(
    { id: "a", status: "live", trigger_condition: "a slow database query in a loader", body_ref: "improve/skills/a.md" },
    { id: "b", status: "live", trigger_condition: "slow database query inside a loader", body_ref: "improve/skills/b.md" },
    { id: "c", status: "live", trigger_condition: "a missing accessibility label", body_ref: "improve/skills/c.md" },
    { id: "d", status: "candidate", trigger_condition: "a slow database query in a loader", body_ref: "improve/skills/a.md" }
  );

  const proposals = await mergeProposals(e);
  assert.deepEqual(
    proposals.map((p) => [p.a, p.b]),
    [["a", "b"]],
    "only the live near-duplicate pair, and never the candidate"
  );
});
