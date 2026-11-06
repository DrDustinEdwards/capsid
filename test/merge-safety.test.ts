import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MERGED_APPROVAL_REASON } from "../src/approval-executor.ts";
import { CONTROLS, performControl, previewControl } from "../src/controls.ts";
import { judgeUnits } from "../src/merge-units.ts";
import { countsFrom, judgeShutoff, LIFTED_KEY, PAUSED_KEY, planResume, readPaused, resumeNamespace, revertsTick, REVERTS_STAMP_KEY, revertTargets, type AuditEvidence, type OutcomeEvidence } from "../src/merge-safety.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The auto-merge safety meter and shutoff (src/merge-safety.ts): what a revert names,
// the weekly counts, the pause, and the resume. The parts that read D1 and GitHub are in
// test-integration/merge-safety.test.ts.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const REPO = "example/capsid";

const merged = (pr: number, daysAgo: number, ns = "capsid"): AuditEvidence => ({ action: "auto-merged", namespace: ns, params: JSON.stringify({ repo: REPO, pr, path_class: "docs" }), at: at(daysAgo) });
const reverted = (pr: number, by: number, daysAgo: number, ns = "capsid"): AuditEvidence => ({
  action: "auto-merge-reverted",
  namespace: ns,
  params: JSON.stringify({ repo: REPO, pr, reverted_by: by, path_class: "docs", merged_at: at(daysAgo) }),
  at: at(daysAgo),
});
const outcome = (pr: number | null, kind: string, daysAgo: number, ns = "capsid"): OutcomeEvidence => ({ namespace: ns, repo: REPO, pr, outcome: kind, run_at: at(daysAgo) });

// revertTargets

test("revertTargets reads GitHub's revert button: the title and the body's 'Reverts owner/repo#N'", () => {
  assert.deepEqual(revertTargets('Revert "Tidy the docs"', "Reverts example/capsid#41", REPO), { prs: [41], shas: [] });
  assert.deepEqual(revertTargets('Revert "Tidy the docs"', "Reverts Example/Capsid#41\n\nThe deploy failed.", REPO), { prs: [41], shas: [] });
});

test("revertTargets reads 'reverts #N' and 'revert #N' in any letter case, from the title or the body", () => {
  assert.deepEqual(revertTargets("Undo it", "this REVERTS #11\nREVERTS #12\nrevert #13", REPO).prs, [12, 13]);
  assert.deepEqual(revertTargets("Revert #7", "", REPO).prs, [7]);
});

test("revertTargets reads git's 'This reverts commit <sha>' from 7 hex characters up", () => {
  const sha = "bfae8ca9012345678901234567890123456789ab";
  assert.deepEqual(revertTargets('Revert "x"', `This reverts commit ${sha}.`, REPO), { prs: [], shas: [sha] });
  assert.deepEqual(revertTargets("x", "This reverts commit BFAE8CA.", REPO).shas, ["bfae8ca"]);
  assert.deepEqual(revertTargets("x", "This reverts commit bfae8c.", REPO).shas, [], "a 6-character prefix named a commit");
});

test("revertTargets ignores another repo's pull request and prose that merely mentions a number", () => {
  assert.deepEqual(revertTargets("Revert", "Reverts other/repo#41", REPO), { prs: [], shas: [] });
  assert.deepEqual(revertTargets("Fix #41", "Closes #41. Reverting nothing; see #12.", REPO), { prs: [], shas: [] });
  assert.deepEqual(revertTargets("", "", REPO), { prs: [], shas: [] });
});

test("revertTargets reads a bare 'revert #N' only at the start of the title or of a body line, not in prose", () => {
  assert.deepEqual(revertTargets("Don't revert #12 here", "We should not revert #13 yet, and nobody reverts #14.", REPO).prs, []);
  assert.deepEqual(revertTargets("Tidy", "Notes\n  - Reverts #21\nrevert #22 now", REPO).prs, [21, 22]);
});

test("the revert pass runs at most once in 30 minutes, by its KV stamp", async () => {
  const kv = fakeKv({ seed: { [REVERTS_STAMP_KEY]: new Date(NOW.getTime() - 10 * 60_000).toISOString() } });
  // A DB that throws proves the gated pass reads nothing else.
  const env = fakeEnv({ APP_KV: kv.kv, DB: { prepare: () => { throw new Error("D1 read inside the gate"); } } });
  const report = await revertsTick(env, NOW);
  assert.equal(report.ran, false);
  assert.match(report.note, /10 of 30 minutes/);
});

// countsFrom

test("countsFrom counts the last seven days only, and approved leaves out the policy's own duplicate row", () => {
  const rows: AuditEvidence[] = [
    merged(1, 1),
    merged(2, 6.5),
    merged(3, 8),
    { action: "approved-merged", namespace: "capsid", params: JSON.stringify({ reason: "approved by Dustin" }), at: at(2) },
    { action: "approved-merged", namespace: "capsid", params: JSON.stringify({ reason: AUTO_MERGED_APPROVAL_REASON }), at: at(2) },
    // SQLite's own text form, no zone.
    { action: "approved-merged", namespace: "capsid", params: "{}", at: at(1).replace("T", " ").slice(0, 19) },
  ];
  const [c] = countsFrom(rows, [outcome(null, "verified", 1), outcome(null, "verified", 9), outcome(null, "rolled_back", 2), outcome(null, "rollback_failed", 3)], ["capsid"], NOW);
  assert.equal(c!.auto_merged, 2);
  assert.equal(c!.approved, 2);
  assert.equal(c!.deploys_verified, 1);
  assert.equal(c!.rolled_back, 1);
  assert.equal(c!.rollback_failed, 1);
  assert.equal(c!.bad_auto_7d, 0, "a rollback with no pull request was counted against the tick");
});

test("bad_auto_7d joins a rollback to the tick's merge, adds reverts, and counts one pull request once", () => {
  const rows = [merged(41, 3), merged(42, 3), merged(43, 3), reverted(43, 50, 1), reverted(42, 51, 1)];
  const [c] = countsFrom(rows, [outcome(41, "rolled_back", 2), outcome(43, "rolled_back", 2), outcome(99, "rolled_back", 1)], ["capsid"], NOW);
  assert.equal(c!.reverts, 2);
  // 41 rolled back, 42 reverted, 43 rolled back and reverted: three pull requests. 99 was not the tick's.
  assert.equal(c!.bad_auto_7d, 3);
});

test("a pull request's bad event is its latest after the lift, so a fresh revert of an old rollback counts, once", () => {
  const rows = [merged(41, 20), merged(42, 20), reverted(41, 50, 1)];
  const rolled = [outcome(41, "rolled_back", 18), outcome(42, "rolled_back", 19)];
  const [c] = countsFrom(rows, rolled, ["capsid"], NOW);
  assert.equal(c!.bad_auto_7d, 1, "the old rollback of 41 hid its fresh revert");
  // Neither is a pause on its own: 41 is this week's one event, 42 sits in the 30 days before.
  assert.deepEqual(judgeShutoff([c!], {}, {}, NOW), {});
  // After a resume 5 days ago, 42's old rollback is answered, and 41's fresh revert is the one event.
  const answered = judgeShutoff([c!], {}, { capsid: at(5) }, NOW);
  assert.deepEqual(answered, {});
  const withSecond = countsFrom([...rows, reverted(42, 52, 0.5)], rolled, ["capsid"], NOW);
  assert.deepEqual(Object.keys(judgeShutoff(withSecond, {}, { capsid: at(5) }, NOW)), ["capsid"], "a fresh revert of 42 after the lift did not count with 41's");
});

test("countsFrom lists a policy namespace with no event, and one only seen in the evidence", () => {
  const counts = countsFrom([merged(1, 1, "carrel")], [], ["capsid"], NOW);
  assert.deepEqual(counts.map((c) => [c.namespace, c.auto_merged]).sort(), [["capsid", 0], ["carrel", 1]]);
});

// judgeShutoff

test("PLANT: two rollbacks of auto-merged pull requests in 7 days pause the namespace", () => {
  const counts = countsFrom([merged(41, 3), merged(42, 3)], [outcome(41, "rolled_back", 2), outcome(42, "rollback_failed", 1)], ["capsid"], NOW);
  const paused = judgeShutoff(counts, {}, {}, NOW);
  assert.deepEqual(Object.keys(paused), ["capsid"]);
  assert.match(paused.capsid!, /2 of the pull requests auto-merge merged were rolled back or reverted in 7 days/);
});

test("PLANT: one rollback and one revert pause the namespace", () => {
  const counts = countsFrom([merged(41, 3), merged(42, 3), reverted(42, 50, 1)], [outcome(41, "rolled_back", 2)], ["capsid"], NOW);
  assert.deepEqual(Object.keys(judgeShutoff(counts, {}, {}, NOW)), ["capsid"]);
});

test("PLANT: a 7-day rate over 3 times a nonzero baseline pauses on one event", () => {
  // The 30 days before: 1 bad of 20 (5%). This week: 1 bad of 4 (25%), which is over 15%.
  const rows = [...Array.from({ length: 20 }, (_, i) => merged(100 + i, 10 + i / 2)), ...Array.from({ length: 4 }, (_, i) => merged(200 + i, 1 + i))];
  const counts = countsFrom(rows, [outcome(100, "rolled_back", 12), outcome(200, "rolled_back", 1)], ["capsid"], NOW);
  const paused = judgeShutoff(counts, {}, {}, NOW);
  assert.match(paused.capsid ?? "", /1 of 4 auto-merged pull request\(s\).*the 1 of 20/);
  // The same week against a baseline it does not exceed: 1 bad of 4 against 3 bad of 8.
  const mild = countsFrom(
    [...Array.from({ length: 8 }, (_, i) => merged(100 + i, 10 + i)), ...Array.from({ length: 4 }, (_, i) => merged(200 + i, 1 + i))],
    [outcome(100, "rolled_back", 12), outcome(101, "rolled_back", 13), outcome(102, "rolled_back", 14), outcome(200, "rolled_back", 1)],
    ["capsid"],
    NOW
  );
  assert.deepEqual(judgeShutoff(mild, {}, {}, NOW), {});
});

test("one bad event against a clean baseline does not pause; only the count rule applies there", () => {
  const counts = countsFrom([merged(41, 3), ...Array.from({ length: 10 }, (_, i) => merged(100 + i, 15 + i))], [outcome(41, "rolled_back", 2)], ["capsid"], NOW);
  assert.equal(counts[0]!.bad_auto_7d, 1);
  assert.deepEqual(judgeShutoff(counts, {}, {}, NOW), {});
});

test("PLANT: events at or before the lifted time are answered and do not pause again; a later one counts", () => {
  const counts = countsFrom([merged(41, 3), merged(42, 3)], [outcome(41, "rolled_back", 2), outcome(42, "rolled_back", 1)], ["capsid"], NOW);
  assert.deepEqual(Object.keys(judgeShutoff(counts, {}, { capsid: at(0.5) }, NOW)), [], "answered rollbacks paused the namespace again");
  assert.deepEqual(Object.keys(judgeShutoff(counts, {}, { capsid: at(1) }, NOW)), [], "an event at the lifted time counted");
  assert.deepEqual(Object.keys(judgeShutoff(counts, {}, { capsid: at(1.5) }, NOW)), [], "one event after the lift is not two");
  assert.deepEqual(Object.keys(judgeShutoff(counts, {}, { capsid: at(5) }, NOW)), ["capsid"]);
});

test("a namespace already paused is not paused again", () => {
  const counts = countsFrom([merged(41, 3), merged(42, 3)], [outcome(41, "rolled_back", 2), outcome(42, "rolled_back", 1)], ["capsid"], NOW);
  assert.deepEqual(judgeShutoff(counts, { capsid: { since: at(1), reason: "x" } }, {}, NOW), {});
});

// A revert counts as a rollback of an unattended merge

test("PLANT: a revert of an unattended merge suspends its unit, like a rollback", () => {
  const revert = { kind: "revert" as const, reverted_by: 50, namespace: "capsid", repo: REPO, pr: 41, head_sha: "a".repeat(40), run_id: 0, run_at: at(1), merged_by: "tick" as const, path_class: "docs" };
  const report = judgeUnits([], [revert], [], NOW);
  assert.deepEqual(report.suspended.map((s) => s.unit), ["capsid/docs"]);
  assert.match(report.suspended[0]!.reason, /example\/capsid#41 merged unattended and was reverted by example\/capsid#50/);
  assert.equal(report.proposals[0]!.kind, "demote");
  // Dustin lifted the suspension after the revert merged: it is answered.
  assert.deepEqual(judgeUnits([], [revert], [], NOW, { "capsid/docs": at(0.5) }).suspended, []);
});

test("a revert blocks the promotion of its unit", () => {
  const approvals = Array.from({ length: 20 }, (_, i) => ({ namespace: "capsid", path_class: "tests", status: "merged", close_reason: null, closed_at: at(14 - (i * 14) / 19) }));
  assert.equal(judgeUnits(approvals, [], [], NOW).proposals.length, 1);
  const revert = { kind: "revert" as const, reverted_by: 50, namespace: "capsid", repo: REPO, pr: 41, head_sha: "a".repeat(40), run_id: 0, run_at: at(1), merged_by: "approval" as const, path_class: "tests" };
  assert.deepEqual(judgeUnits(approvals, [revert], [], NOW).proposals, []);
});

// Resume

function world(paused: object | null = { capsid: { since: at(1), reason: "2 rolled back" } }) {
  const d1 = fakeD1({});
  const kv = fakeKv({ seed: paused ? { [PAUSED_KEY]: JSON.stringify(paused) } : {} });
  const env = fakeEnv({ DB: d1.db, APP_KV: kv.kv, COOKIE_ENCRYPTION_KEY: "test-cookie-key", IMPROVE_SCORE_SECRET: "s" });
  return { d1, kv, env };
}
const auditRows = (d1: ReturnType<typeof fakeD1>) => d1.recorded.filter((r) => /INSERT INTO audit_log/.test(r.sql)).map((r) => ({ actor: r.params[0] as string, action: r.params[1] as string, namespace: r.params[2] as string }));

test("PLANT: resumeNamespace lifts the pause, records when, and audits once", async () => {
  const w = world();
  const done = await resumeNamespace(w.env, "access:admin@example.com", "capsid", "both rollbacks are answered", NOW);
  assert.ok(done.ok);
  assert.deepEqual(await readPaused(w.kv.kv), {});
  assert.deepEqual(JSON.parse(w.kv.store.get(LIFTED_KEY)!), { capsid: NOW.toISOString() });
  assert.deepEqual(auditRows(w.d1), [{ actor: "access:admin@example.com", action: "auto-merge-resumed", namespace: "capsid" }]);
  const again = await resumeNamespace(w.env, "access:admin@example.com", "capsid", "again", NOW);
  assert.equal(again.ok, false);
  assert.equal(auditRows(w.d1).length, 1, "a namespace not paused was audited as resumed");
});

test("planResume refuses a namespace that is not paused, and a malformed name", async () => {
  const w = world();
  assert.match((await planResume(w.kv.kv, "carrel") as { refusal: string }).refusal, /auto-merge for carrel is not paused/);
  assert.match((await planResume(w.kv.kv, "Bad Name") as { refusal: string }).refusal, /needs a namespace/);
  assert.equal((await planResume(w.kv.kv, " capsid ")).ok, true);
});

test("PLANT: the automerge_resume control is refused without a reason and when the namespace is not paused, and lifts and audits otherwise", async () => {
  assert.ok(CONTROLS.some((c) => c.name === "automerge_resume"));
  const w = world();
  const email = "admin@example.com";
  const noReason = await previewControl(w.env, email, "automerge_resume", { namespace: "capsid" }, NOW, "portal");
  assert.equal(noReason.ok, false);
  assert.match(noReason.ok ? "" : noReason.refusal, /needs a reason/);
  const notPaused = await previewControl(w.env, email, "automerge_resume", { namespace: "carrel", reason: "x" }, NOW, "portal");
  assert.equal(notPaused.ok, false);
  assert.match(notPaused.ok ? "" : notPaused.refusal, /not paused/);
  assert.deepEqual(auditRows(w.d1), [], "a refusal wrote");

  const previewed = await previewControl(w.env, email, "automerge_resume", { namespace: "capsid", reason: "answered" }, NOW, "portal");
  assert.ok(previewed.ok);
  assert.deepEqual(Object.keys(await readPaused(w.kv.kv)), ["capsid"], "the preview lifted the pause");
  const performed = await performControl(w.env, email, previewed.ok ? previewed.preview.token : null, null, NOW, "portal");
  assert.ok(performed.ok, performed.ok ? "" : performed.refusal);
  assert.deepEqual(await readPaused(w.kv.kv), {});
  assert.deepEqual(auditRows(w.d1).map((r) => r.action).sort(), ["auto-merge-resumed", "portal-automerge_resume"]);
});
