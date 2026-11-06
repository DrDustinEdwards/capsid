import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeUnits, REPORT_KEY, SUSPENDED_KEY, unitInboxItems, unitsTick, type ApprovalEvidence, type RollbackEvidence } from "../src/merge-units.ts";
import { fakeKv } from "./fakes.ts";

// Earned promotion and demotion (docs/design/design-merge-pipeline.md section 7, PR 9;
// DECIDE 9 and 10 of 2026-10-09). Proves: a fixture with 20 clean merges proposes; one
// rollback suspends the unit. Report-only: nothing here widens anything.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

/** `n` merged approvals in one unit, spread evenly over `spanDays`. */
function merges(n: number, spanDays: number, namespace = "capsid", pathClass = "tests"): ApprovalEvidence[] {
  return Array.from({ length: n }, (_, i) => ({ namespace, path_class: pathClass, status: "merged", close_reason: null, closed_at: at(spanDays - (n === 1 ? 0 : (i * spanDays) / (n - 1))) }));
}
const voided = (reason: string): ApprovalEvidence => ({ namespace: "capsid", path_class: "tests", status: "voided", close_reason: reason, closed_at: at(1) });
const rollback = (over: Partial<RollbackEvidence> = {}): RollbackEvidence => ({
  kind: "rollback",
  namespace: "capsid",
  repo: "owner/capsid",
  pr: 41,
  head_sha: "a".repeat(40),
  run_id: 7,
  run_at: at(1),
  merged_by: "tick",
  path_class: "docs",
  ...over,
});

test("PLANT: 20 clean approved merges over 14 days propose promoting the unit", () => {
  const report = judgeUnits(merges(20, 14), [], [], NOW);
  assert.equal(report.proposals.length, 1);
  const p = report.proposals[0]!;
  assert.equal(p.kind, "promote");
  assert.equal(p.unit, "capsid/tests");
  assert.deepEqual(p.evidence, { approved_merges: 20, span_days: 14, rollbacks: 0, bad_voids: 0 });
  assert.match(p.title, /^Promote capsid tests to auto: 20 approved over 14 days, 0 rollbacks$/);
});

test("19 merges, or 20 over 13 days, propose nothing", () => {
  assert.equal(judgeUnits(merges(19, 30), [], [], NOW).proposals.length, 0);
  assert.equal(judgeUnits(merges(20, 13), [], [], NOW).proposals.length, 0);
});

test("one void against the unit is allowed, two are not; a void for a new push never counts", () => {
  assert.equal(judgeUnits([...merges(20, 14), voided("CI red: build failed")], [], [], NOW).proposals.length, 1);
  assert.equal(judgeUnits([...merges(20, 14), voided("CI red: x"), voided("undone")], [], [], NOW).proposals.length, 0);
  assert.equal(judgeUnits([...merges(20, 14), voided("new push: approved at a, head is b"), voided("new push: approved at b, head is c"), voided("head moved: x"), voided("head moved: y"), voided("replaced"), voided("replaced")], [], [], NOW).proposals.length, 1);
});

test("an approval with no unit recorded (before migration 0043) counts toward none", () => {
  const old = merges(20, 14).map((a) => ({ ...a, namespace: null, path_class: null }));
  assert.equal(judgeUnits(old, [], [], NOW).proposals.length, 0);
});

test("PLANT: one rollback of an unattended merge suspends its unit and proposes removing it", () => {
  const report = judgeUnits([], [rollback()], [], NOW);
  assert.deepEqual(report.suspended.map((s) => s.unit), ["capsid/docs"]);
  assert.match(report.suspended[0]!.reason, /owner\/capsid#41 merged unattended and was rolled back/);
  assert.equal(report.proposals.length, 1);
  assert.equal(report.proposals[0]!.kind, "demote");
});

test("a rollback of an approved merge blocks the unit's promotion but suspends nothing", () => {
  const report = judgeUnits(merges(20, 14), [rollback({ merged_by: "approval", path_class: "tests" })], [], NOW);
  assert.deepEqual(report.suspended, []);
  assert.deepEqual(report.proposals, []);
});

test("a suspended unit is never proposed for promotion, and a rollback with no known unit suspends nothing and says so", () => {
  const susp = [{ unit: "capsid/tests", since: at(3), reason: "earlier" }];
  const report = judgeUnits(merges(25, 20), [rollback({ path_class: null })], susp, NOW);
  assert.deepEqual(report.proposals, []);
  assert.deepEqual(report.suspended, susp);
  assert.equal(report.unplaced.length, 1);
});

function env(seed: Record<string, string> = {}) {
  const kv = fakeKv({ seed });
  const batches: unknown[][] = [];
  const db = {
    prepare: (sql: string) => ({ sql, bind: (...p: unknown[]) => ({ sql, params: p }) }),
    batch: async (s: unknown[]) => (batches.push(s), s.map(() => ({ results: [], meta: {} }))),
  };
  return { env: { DB: db, APP_KV: kv.kv } as never, kv, batches };
}

test("the step suspends once, audits once, and the next pass changes nothing", async () => {
  const w = env();
  const read = async () => ({ approvals: [], rollbacks: [rollback()] });
  const first = await unitsTick(w.env, NOW, read);
  assert.deepEqual(first.newly_suspended, ["capsid/docs"]);
  assert.equal(w.batches.length, 1, "the suspension was not audited");
  assert.deepEqual(JSON.parse(w.kv.store.get(SUSPENDED_KEY)!).map((s: { unit: string }) => s.unit), ["capsid/docs"]);
  const second = await unitsTick(w.env, new Date(NOW.getTime() + 300_000), read);
  assert.equal(second.ran, false);
  assert.equal(w.batches.length, 1, "the same suspension was audited twice");
});

test("proposals and suspensions reach the inbox as kind proposal, per namespace", async () => {
  const w = env();
  await unitsTick(w.env, NOW, async () => ({ approvals: merges(20, 14, "carrel", "src-routine"), rollbacks: [rollback()] }));
  assert.ok(w.kv.store.get(REPORT_KEY));
  const items = await unitInboxItems(w.kv.kv);
  assert.deepEqual(
    items.map((i) => [i.namespace, i.item.kind, i.item.title.split(":")[0]]),
    [
      ["capsid", "proposal", "capsid docs is suspended from auto"],
      ["capsid", "proposal", "Remove capsid docs from auto"],
      ["carrel", "proposal", "Promote carrel src-routine to auto"],
    ]
  );
});
