import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeEdit, mergeProposals, rejectedEdits } from "../src/skills-evaluate.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The gate that accepts an edit and the duplicate detector. The deciding rules live in
// ./skills-lifecycle and are tested there; this is the half that touches rows.

function env(kv: Record<string, string> = {}, opts: Parameters<typeof fakeD1>[0] = {}) {
  const fake = fakeD1(opts);
  return { fake, env: fakeEnv({ DB: fake.db, APP_KV: fakeKv({ seed: kv }).kv }) };
}

// the edit gate

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

// merge proposals

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
