import assert from "node:assert/strict";
import { test } from "node:test";
import { CORRECTION_CAP, RETRY_CAP_REASON, atCorrectionCap, cappedSummary } from "../src/jobs-schema.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { resumeJob } from "../src/jobs.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeEnv } from "./fakes.ts";

// GROUP 2: TWO CORRECTIONS, THEN A HUMAN.
//
// `resume` made a gate a pause rather than an ending, which is right. What it left
// unbounded is the LOOP: block, sent back, block again, sent back again, block
// again. Every step is defensible on its own and the composition is not, so the
// ceiling is counted rather than judged.
//
// The rules live as pure functions here for the same reason the skill lifecycle
// does: they can be driven to their refusals without a database.

test("a job under the cap is not capped, and a job at it is", () => {
  assert.equal(atCorrectionCap(0), false);
  assert.equal(atCorrectionCap(1), false, "one correction is a driver fixing something, not a loop");
  assert.equal(atCorrectionCap(2), true, "the third block is the one a human decides");
  assert.equal(atCorrectionCap(9), true);
});

test("a corrupt or negative count is treated as at the cap, not under it", () => {
  // Fail closed. A count this function cannot read is a count it cannot bound, and
  // waving that through would hand the loop exactly the case nobody tested.
  assert.equal(atCorrectionCap(Number.NaN), true);
  assert.equal(atCorrectionCap(-1), true);
});

test("the capped summary names the cap and KEEPS what the driver said", () => {
  const summary = cappedSummary("the push needs a human");
  assert.match(summary, new RegExp(RETRY_CAP_REASON));
  assert.match(summary, /the push needs a human/, "a cap that discards the driver's summary throws away what the human has to decide about");
});

test("capping an empty summary still says why the job stopped", () => {
  assert.match(cappedSummary(null), new RegExp(RETRY_CAP_REASON));
  assert.match(cappedSummary(""), new RegExp(RETRY_CAP_REASON));
});

// ---- the behavioural half, against a row that can disagree -----------------------
//
// The rules above are pure and the branch that uses them is not. These drive the real
// resumeJob against a fake D1 that holds a row, so a cap that is computed correctly
// and then never consulted is caught here rather than in production.

interface Recorded {
  sql: string;
  params: unknown[];
}

// `siblingSpent` is what OTHER rows sharing this row's (namespace, title) have already
// spent. The cap is counted across the work rather than the row (ruled 2026-09-13), so
// a fake that can only hold one row cannot express the case the ruling is about: the
// same work posted again after a fail, or beside a blocked row, on a fresh row at 0.
function resumeDb(row: Record<string, unknown>, siblingSpent = 0) {
  const recorded: Recorded[] = [];
  const stmt = (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...bound: unknown[]) => stmt(sql, bound),
      first: async () => {
        if (/SELECT \* FROM jobs WHERE status = 'claimed' AND claimed_by/i.test(flat)) return null;
        if (/SELECT \* FROM jobs WHERE id = \?1/i.test(flat)) return params[0] === row.id ? { ...row } : null;
        // THE WORK-WIDE CORRECTION BUDGET (audit 2026-09-13, finding 9). Summed over
        // every job sharing (namespace, title); this fake holds one row, so the sum is
        // that row's count. Modelled rather than left unanswered because
        // correctionsForWork fails CLOSED, so a fake that returns nothing turns every
        // resume in the suite into a refusal.
        if (/SUM\(corrections_count\)/i.test(flat)) return { spent: Number(row.corrections_count ?? 0) + siblingSpent };
        if (/SELECT id, title, body FROM documents/i.test(flat)) return null;
        // The transition's guard (requireJobUnchanged), first in the batch: it aborts the
        // whole batch unless the row is in the state the caller read.
        if (/WHERE NOT EXISTS \(SELECT 1 FROM jobs/i.test(flat)) {
          const [id, status, claimedBy, updatedAt] = params;
          if (row.id !== id || row.status !== status || (row.claimed_by ?? null) !== claimedBy || row.updated_at !== updatedAt) {
            throw new Error("NOT NULL constraint failed: document_versions.document_id");
          }
          return null;
        }
        if (/^UPDATE jobs SET/i.test(flat)) {
          recorded.push({ sql: flat, params });
          if (params[0] !== row.id || row.status !== "blocked") return null;
          row.status = "claimed";
          // The claimant and the timestamps the statement writes, applied from the
          // BOUND params rather than assumed, so a resume that hands the lease to the
          // wrong caller, or rewrites claimed_at, is visible on the row.
          row.claimed_by = params[1];
          if (/claimed_at = \?3/i.test(flat)) row.claimed_at = params[2];
          // The fake APPLIES the increment the statement asks for rather than
          // assuming it. A fake that kept its own answer is how a plant deleting the
          // clause leaves a suite green (test/skills-records.test.ts, 2026-09-12).
          const spend = params[4];
          if (typeof spend === "number") row.corrections_count = Number(row.corrections_count) + spend;
          // updated_at from the bound param the statement names, so a guard built from
          // this write's result matches the row it left.
          const stamp = /updated_at = \?(\d+)/.exec(flat);
          if (stamp) row.updated_at = params[Number(stamp[1]) - 1];
          return { id: row.id };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({}),
      raw: async () => [],
    } as unknown as D1PreparedStatement;
  };
  return {
    recorded,
    row,
    db: {
      prepare: (sql: string) => stmt(sql),
      // Each statement runs through first(), in order, so the UPDATE the batch carries
      // moves the row and the guard in front of it can abort the batch.
      batch: async (statements: unknown[]) => {
        for (const s of statements) await (s as D1PreparedStatement).first();
        for (const s of statements) recorded.push(s as Recorded);
        return [];
      },
    } as unknown as D1Database,
  };
}

function agentNamed(name: string, admin: boolean) {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_aaaabbbbcccc", name, kind: admin ? "seat" : "driver", actor: `agent:${name}`, scopes, admin, row: null };
}

async function blockedRow(corrections: number) {
  return {
    id: "job_4c0ecc28548b",
    namespace: "capsid",
    title: "a job that keeps hitting the same wall",
    body: await signTaskBody(SECRET, "Do the thing."),
    priority: 0,
    status: "blocked",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-12T00:00:00.000Z",
    lease_expires: null,
    result_ref: null,
    result_summary: "stopped at the push",
    gate_required: 1,
    created_at: "2026-09-11T22:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
    resumed_count: corrections,
    blocked_count: corrections + 1,
    corrections_count: corrections,
    required_scopes: null,
    min_record: null,
  };
}

const SECRET = "retry-cap-test-secret";
const NOW = new Date("2026-09-12T03:00:00Z");

test("the first two corrections are allowed, and each one spends the budget", async () => {
  // The innocent case first: a cap that refused ordinary work would be found by an
  // outage rather than by a test.
  for (const corrections of [0, 1]) {
    const { db, row } = resumeDb(await blockedRow(corrections));
    const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
    const result = await resumeJob(env, agentNamed("other-driver", false) as never, NOW, "job_4c0ecc28548b", "fix the review findings", {
      correction: true,
    });
    assert.equal(result.ok, true, `correction ${corrections + 1} refused: ${JSON.stringify(result)}`);
    assert.equal(row.corrections_count, corrections + 1, "a correction that does not spend the budget can never reach the cap");
  }
});

test("PLANT: a PLAIN resume spends nothing, so ordinary pushes never reach the cap", async () => {
  // job_466d6472511e, 2026-09-16: three ordinary pushes, each one blocked and resumed,
  // put the job at corrections_count 2 and the next resume was refused as a retry
  // loop. Nothing had been corrected. Three plain resumes here, and the budget must
  // still read 0 after all of them.
  const { db, row } = resumeDb(await blockedRow(0));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  for (let i = 1; i <= 3; i++) {
    const result = await resumeJob(env, agentNamed("other-driver", false) as never, NOW, "job_4c0ecc28548b", `push ${i} ran`);
    assert.equal(result.ok, true, `plain resume ${i} refused: ${JSON.stringify(result)}`);
    assert.equal(row.corrections_count, 0, `plain resume ${i} spent a correction`);
    row.status = "blocked";
  }
});

test("THE THIRD RESUME IS REFUSED, and the refusal names the cap", async () => {
  const { db, row } = resumeDb(await blockedRow(CORRECTION_CAP));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("other-driver", false) as never, NOW, "job_4c0ecc28548b", "one more go");
  assert.equal(result.ok, false);
  assert.match(String(result.refusal), new RegExp(RETRY_CAP_REASON));
  assert.match(String(result.refusal), /admin caller may resume it/, "a refusal that does not say who CAN act leaves the job stuck with no route out");
  assert.equal(row.status, "blocked", "a refused resume must leave the job exactly as it was");
  assert.equal(row.corrections_count, CORRECTION_CAP, "a refused resume must not spend the budget it was refused for");
});

test("PLANT: re-posting the same work does NOT reset the correction budget", async () => {
  // Audit 2026-09-13, finding 9. The unique open-title index covers only `queued` and
  // `claimed`, so failing a job, or leaving it blocked, frees (namespace, title) to be
  // posted again on a fresh row at corrections_count 0. The cap was read off that row,
  // so the ceiling reset and the loop it bounds was unbounded by the cheapest possible
  // move. Counted per (namespace, title) now, index untouched, per the ruling.
  //
  // This row is brand new and has spent nothing; its predecessors spent the whole cap.
  const { db, row } = resumeDb(await blockedRow(0), CORRECTION_CAP);
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("other-driver", false) as never, NOW, "job_4c0ecc28548b", "posting it again");
  assert.equal(result.ok, false, "a fresh row for the same work reset the cap");
  assert.match(String(result.refusal), new RegExp(RETRY_CAP_REASON));
  assert.match(String(result.refusal), /per \(namespace, title\) rather than per row/, "the refusal must say why re-posting did not help");
  assert.equal(row.status, "blocked");
  assert.equal(row.corrections_count, 0, "a refused resume must not spend a budget it was refused for");
});

test("THE INNOCENT DIRECTION: work whose siblings spent nothing still resumes", async () => {
  // Without this, a cap that refused everything would pass the plant above.
  const { db, row } = resumeDb(await blockedRow(0), 0);
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("other-driver", false) as never, NOW, "job_4c0ecc28548b", "first go");
  assert.equal(result.ok, true, `an unspent budget was refused: ${JSON.stringify(result)}`);
  assert.equal(row.status, "claimed");
});

test("THE SEAT IS ALSO REFUSED at the cap, because the seat is not the human", async () => {
  // The seat holds a write grant and can_merge and is still a machine. If the cap
  // stopped at "not a driver" it would be lifted by the party it exists to bound.
  const { db } = resumeDb(await blockedRow(CORRECTION_CAP));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("seat", false) as never, NOW, "job_4c0ecc28548b", "the seat says go");
  assert.equal(result.ok, false);
  assert.match(String(result.refusal), new RegExp(RETRY_CAP_REASON));
});

test("AN ADMIN RESUME IS ALLOWED at the cap, and does not spend the budget", async () => {
  const { db, row } = resumeDb(await blockedRow(CORRECTION_CAP));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  // Passed as a correction, so the exemption is what keeps the budget still rather
  // than the absence of a correction.
  const result = await resumeJob(env, agentNamed("admin", true) as never, NOW, "job_4c0ecc28548b", "I looked at it and it is fine", {
    correction: true,
  });
  assert.equal(result.ok, true, `an admin resume was refused: ${JSON.stringify(result)}`);
  assert.equal(row.status, "claimed");
  assert.equal(
    row.corrections_count,
    CORRECTION_CAP,
    "an admin resume that spent the budget would push the job further past a cap the admin just cleared"
  );
});
