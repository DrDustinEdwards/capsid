import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { blockJob, completeJob, failJob } from "../src/jobs.ts";
import { atCorrectionCap } from "../src/jobs-schema.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// GROUP 4, THE BEHAVIOURAL HALF.
//
// test/review.test.ts drives the parser, which is pure. These drive the real
// completeJob and blockJob against a row that can disagree, because a verdict
// computed correctly and then not acted on is exactly what a pure test cannot see.

interface Recorded {
  sql: string;
  params: unknown[];
}

// THE AUDIT ROWS THAT SAY WHICH COMMENTS CAPSID POSTED, AND FOR WHOM.
//
// The review gate reads these to tell a reviewer's verdict from prose anybody with a
// `gh` token wrote on the pull request: every comment Capsid posts is authored by the
// same App installation, so the login on the comment cannot answer it. Default: the
// comments withComments serves were posted for an agent holding can_comment_pr.
function reviewerAudit(ids: number[], opts: { actor?: string; canComment?: boolean } = {}) {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_comment_pr = opts.canComment !== false;
  return ids.map((id) => ({
    actor: opts.actor ?? "agent:capsid-reviewer",
    params: JSON.stringify({ repo: "DrDustinEdwards/capsid-mcp", number: 27, action: "comment", comment_id: id }),
    scopes: serializeScopes(scopes),
  }));
}

// The comment ids withComments hands out, in the order it hands them out.
const COMMENT_IDS = [100, 101, 102, 103];

function queueDb(row: Record<string, unknown>, audit: unknown[] = reviewerAudit(COMMENT_IDS)) {
  const recorded: Recorded[] = [];
  const stmt = (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...bound: unknown[]) => stmt(sql, bound),
      first: async () => {
        if (/SELECT \* FROM jobs WHERE id = \?1/i.test(flat)) return params[0] === row.id ? { ...row } : null;
        // THE WORK-WIDE CORRECTION BUDGET (audit 2026-09-13, finding 9). Summed over
        // every job sharing (namespace, title); this fake holds one row, so the sum is
        // that row's count. Modelled rather than left unanswered because
        // correctionsForWork fails CLOSED, so a fake that returns nothing turns every
        // resume in the suite into a refusal.
        if (/SUM\(corrections_count\)/i.test(flat)) return { spent: Number(row.corrections_count ?? 0) };
        // The namespace mapping the gate resolves a pull request's repo through.
        if (/SELECT repos FROM namespaces/i.test(flat)) {
          return params[0] === "capsid" ? { repos: JSON.stringify([{ repo: "DrDustinEdwards/capsid-mcp", label: "primary" }]) } : null;
        }
        if (/^UPDATE jobs SET/i.test(flat)) {
          recorded.push({ sql: flat, params });
          if (params[0] !== row.id) return null;
          if (/SET result_ref = \?2/.test(flat)) {
            if (/result_ref IS NULL/.test(flat) && row.result_ref !== null) return null;
            row.result_ref = params[1];
            return { id: row.id };
          }
          // THE FAKE APPLIES WHAT THE STATEMENT ASKS rather than keeping its own
          // answer. A fake that decided for itself is how a plant deleting a clause
          // leaves a suite green, measured on this repo on 2026-09-12.
          if (/corrections_count = corrections_count \+ 1/.test(flat)) {
            row.corrections_count = Number(row.corrections_count) + 1;
          }
          if (/SET status = \?2/.test(flat)) row.status = params[1];
          if (/SET result_summary = \?2/.test(flat)) row.result_summary = params[1];
          if (/result_summary = COALESCE\(\?3/.test(flat) && params[2] !== null) row.result_summary = params[2];
          return { id: row.id };
        }
        return null;
      },
      all: async () => (/FROM audit_log/i.test(flat) ? { results: audit } : { results: [] }),
      run: async () => ({}),
      raw: async () => [],
    } as unknown as D1PreparedStatement;
  };
  return {
    recorded,
    row,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (s: unknown[]) => {
        for (const x of s) recorded.push(x as Recorded);
        return [];
      },
    } as unknown as D1Database,
  };
}

function driver() {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_dddd", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

const PR = "https://github.com/DrDustinEdwards/capsid-mcp/pull/27";

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_reviewme1234",
    namespace: "capsid",
    title: "work that needs a second reader",
    body: "do the thing",
    priority: 0,
    status: "claimed",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-12T09:00:00.000Z",
    lease_expires: "2026-09-12T13:00:00.000Z",
    result_ref: PR,
    result_summary: null,
    gate_required: 0,
    required_scopes: null,
    min_record: null,
    blocked_count: 0,
    resumed_count: 0,
    corrections_count: 0,
    review_required: 1,
    created_at: "2026-09-12T08:00:00.000Z",
    updated_at: "2026-09-12T09:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-12T12:00:00Z");

// The head commit every pull request reports. An APPROVE counts only when it quotes
// this sha, so the approving comments below quote SHORT.
const HEAD_SHA = "abc1234def5678abc1234def5678abc1234def56";
const SHORT = HEAD_SHA.slice(0, 7);

// A fake GitHub. Comments are served per pull request number (the key "*" serves any
// number), each comment i posted at 1i:00, and every pull request's head commit is
// HEAD_SHA. `asked` collects every URL requested.
async function withGitHub<T>(
  comments: Record<string, string[]>,
  fn: () => Promise<T>,
  opts: { asked?: string[] } = {}
): Promise<T> {
  const original = globalThis.fetch;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    opts.asked?.push(url);
    const onComments = /\/issues\/(\d+)\/comments/.exec(url);
    if (onComments) {
      const bodies = comments[onComments[1]] ?? comments["*"] ?? [];
      return json(bodies.map((body, i) => ({ id: COMMENT_IDS[i], user: { login: "reviewer" }, body, created_at: `2026-09-12T1${i}:00:00Z` })));
    }
    if (/\/pulls\/\d+$/.test(url)) return json({ head: { sha: HEAD_SHA } });
    return new Response("not modelled", { status: 404 });
  }) as never;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const withComments = <T>(bodies: string[], fn: () => Promise<T>) => withGitHub({ "*": bodies }, fn);

function reviewEnv(db: D1Database) {
  return fakeEnv({
    DB: db,
    APP_KV: fakeKv({ seedToken: true }).kv,
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
    IMPROVE_SCORE_SECRET: "s",
  });
}

const finish = (db: D1Database) =>
  completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", { result_summary: "opened PR 27", result_ref: PR });

test("NO REVIEW YET: complete is refused and the job stays claimed", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["nice work"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /no review yet/);
    assert.equal(row.status, "claimed", "a job waiting on a review must not move");
  });
});

test("APPROVE: complete proceeds exactly as it would with no reviewer", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments([`REVIEW: the scope check is right at ${SHORT}. APPROVE`], async () => {
    const result = await finish(db);
    assert.equal(result.ok, true, `an approved job was refused: ${JSON.stringify(result)}`);
    assert.equal(row.status, "done");
    assert.equal(row.corrections_count, 0, "an approval must not spend a correction");
  });
});

test("CHANGES: the job goes back to the driver and SPENDS A CORRECTION", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: the error path swallows the refusal. CHANGES"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false);
    assert.equal(row.status, "claimed", "CHANGES sends the work back to the driver, it does not finish the job");
    assert.equal(row.corrections_count, 1, "a rewrite that costs nothing is a loop with no ceiling");
    assert.match(String(row.result_summary), /CHANGES/);
    assert.match(String(row.result_summary), /error path swallows the refusal/, "the row must carry what the reviewer actually said");
    assert.match(String(result.refusal), /1 of 2/, "the driver is told how much of the budget is left");
  });
});

test("A SECOND CHANGES REACHES THE CAP, so a review loop is bounded by the same ceiling a gate loop is", async () => {
  const { db, row } = queueDb(claimedRow({ corrections_count: 1 }));
  await withComments(["REVIEW: still wrong. CHANGES"], async () => {
    await finish(db);
    assert.equal(row.corrections_count, 2);
    assert.equal(atCorrectionCap(Number(row.corrections_count)), true);
  });
});

test("PLANT: AT the cap, a further CHANGES BLOCKS for the seat instead of going round again", async () => {
  // The test above asserts the counter reaches 2. It does not assert that anything
  // STOPS, and nothing did: the rework path always incremented and always left the job
  // claimed, so a third CHANGES spent a third correction and sent the work back. The
  // cap was enforced only on `resume`, which this path never touches (audit
  // 2026-09-13, finding 8). Driven through completeJob, the path a driver calls.
  const { db, row } = queueDb(claimedRow({ corrections_count: 2 }));
  await withComments(["REVIEW: still not right. CHANGES"], async () => {
    // A BLOCK IS A SUCCESSFUL OUTCOME, so the call reports ok: the job stopped for the
    // seat rather than failing. What this test is about is the row, not the return.
    await finish(db);
    assert.equal(row.status, "blocked", "a review loop past the cap sent the work back to the driver again");
    assert.equal(row.corrections_count, 2, "a blocked-for-the-seat job must not also spend another correction");
    assert.match(String(row.result_summary), /retry cap; human decision required/);
    assert.match(String(row.result_summary), /still not right/, "the seat needs the reviewer's actual objection");
  });
});

test("THE INNOCENT DIRECTION: below the cap, CHANGES still goes back to the driver", async () => {
  // Without this, a rework path broken for everybody passes the plant above and every
  // review would land on the seat's desk.
  const { db, row } = queueDb(claimedRow({ corrections_count: 0 }));
  await withComments(["REVIEW: one more pass. CHANGES"], async () => {
    await finish(db);
    assert.equal(row.status, "claimed", "an ordinary CHANGES must stay with the driver");
    assert.equal(row.corrections_count, 1);
  });
});

test("BLOCK: the job is blocked for the seat, carrying the objection", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: this changes the auth model and needs a ruling. BLOCK"], async () => {
    await finish(db);
    assert.equal(row.status, "blocked");
    assert.match(String(row.result_summary), /BLOCK/);
    assert.match(String(row.result_summary), /needs a ruling/);
    assert.equal(row.corrections_count, 0, "a BLOCK is not a correction; nobody is being asked to fix anything");
  });
});

test("THE GATE IS ON BLOCK TOO, so a driver cannot bypass it by blocking instead", async () => {
  // A gate on one transition is not a gate: the driver would use the other, and the
  // bypass would look like ordinary use.
  const { db, row } = queueDb(claimedRow());
  await withComments(["nothing to see here"], async () => {
    const result = await blockJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
      reason: "ready for the seat",
      command: "gh pr merge 27",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /no review yet/);
    assert.equal(row.status, "claimed");
  });
});

test("A JOB WITHOUT review_required IS UNTOUCHED, which is almost every job", async () => {
  // The innocent case. If this failed, the gate would hold work nobody asked to have
  // reviewed, and it would be found by an outage rather than by a test.
  const { db, row } = queueDb(claimedRow({ review_required: 0 }));
  const result = await finish(db);
  assert.equal(result.ok, true, `an ordinary job was held by the review gate: ${JSON.stringify(result)}`);
  assert.equal(row.status, "done");
});

test("PLANT: complete with a DOCUMENT KEY is refused, because the reviewed party chose the ref", async () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and that is the finding. reviewGate returned
  // proceed whenever result_ref was not a pull request URL, and result_ref is chosen by
  // the driver, so the party being reviewed decided whether it was reviewed. The column
  // exists to stop exactly that (migrations/0017_jobs_review.sql). Driven through the
  // real completeJob, not through reviewGate.
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  const result = await completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
    result_summary: "wrote the ruling",
    result_ref: "capsid/decisions.md",
  });
  assert.equal(result.ok, false, "a review_required job closed with a document key and no verdict");
  assert.match(String(result.refusal), /names no pull request/);
  assert.equal(row.status, "claimed");
});

test("EVIDENCE NAMES THE PULL REQUEST TOO, so reporting it there is not a way past the gate", async () => {
  // The other half of the same hole: result_ref a document, evidence.prs the real work.
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  await withComments([`REVIEW: reads fine at ${SHORT}. APPROVE`], async () => {
    const result = await completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
      result_summary: "opened PR 27",
      result_ref: "capsid/decisions.md",
      evidence: { prs: [PR] },
    });
    assert.equal(result.ok, true, `an approved job was refused: ${JSON.stringify(result)}`);
    assert.equal(row.status, "done");
  });
});

test("PLANT: a REVIEW comment Capsid did not post for a reviewer is not a verdict", async () => {
  // The identity half. A driver with local `gh` can write the envelope; what it cannot
  // do is make Capsid record that a can_comment_pr actor asked for that comment. With
  // newest-wins, before this the same comment also overwrote a real CHANGES.
  const { db, row } = queueDb(claimedRow(), reviewerAudit(COMMENT_IDS, { actor: "agent:capsid-driver", canComment: false }));
  await withComments([`REVIEW: looks good to me at ${SHORT}. APPROVE`], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false, "a comment from an actor with no can_comment_pr counted as a review");
    assert.match(String(result.refusal), /no review yet/);
    assert.equal(row.status, "claimed");
  });
});

test("THE GATE IS ON FAIL TOO, so a driver cannot walk away from a CHANGES by failing", async () => {
  // The third way out, and the one nothing consulted at all: complete was gated, block
  // was gated, fail was not. A driver holding a verdict it did not want could close the
  // job as failed and leave the pull request for the seat to find.
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: the refusal is swallowed. CHANGES"], async () => {
    const result = await failJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", "giving up");
    assert.equal(result.ok, false);
    assert.equal(row.status, "claimed", "fail closed a job the reviewer had sent back");
    assert.match(String(row.result_summary), /CHANGES/);
  });
});

test("FAIL WITH NO PULL REQUEST STILL WORKS, because work that could not be done has none", async () => {
  // The innocent case for the rule above. Refusing here would leave a driver unable to
  // report that a job cannot be done, and the only escape would be the admin.
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  const result = await failJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", "the API this needs was retired");
  assert.equal(result.ok, true, `a genuinely failed job was stranded: ${JSON.stringify(result)}`);
  assert.equal(row.status, "failed");
});

// ---- the gate is bound to the job's own pull request and head (audit 2026-09-25, F2-4)

const OLDER_PR = "https://github.com/DrDustinEdwards/capsid-mcp/pull/26";

test("PLANT: after CHANGES, completing with an older APPROVED pull request is refused", async () => {
  // Scenario 1 of the finding. The gate read whichever pull request the call named, so
  // a driver whose job got CHANGES on PR 27 could complete naming PR 26, which a
  // reviewer approved last week, and the gate returned proceed.
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  await withGitHub({ "27": ["REVIEW: the error path is wrong. CHANGES"], "26": [`REVIEW: fine at ${SHORT}. APPROVE`] }, async () => {
    await finish(db);
    assert.equal(row.corrections_count, 1);
    const result = await completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
      result_summary: "done, see PR 26",
      result_ref: OLDER_PR,
    });
    assert.equal(result.ok, false, "an approval of a different pull request passed the gate");
    assert.match(String(result.refusal), /bound to/);
    assert.equal(row.status, "claimed");
    assert.equal(row.result_ref, PR, "the first read did not record the job's pull request");
  });
});

test("PLANT: an APPROVE that quotes no head sha does not pass", async () => {
  // A committer date is set by whoever commits, so a push backdated before the review
  // passed the date check. The sha the reviewer quotes is what ties the approval to
  // the code it read.
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: reads fine. APPROVE"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false, "an APPROVE that names no commit passed the gate");
    assert.match(String(result.refusal), /quote/);
    assert.equal(row.status, "claimed");
    assert.equal(row.corrections_count, 0, "an unpinned approval is not a correction");
  });
});

test("PLANT: an APPROVE quoting an older head sha does not pass", async () => {
  // Scenario 2 of the finding: the reviewer approved 1111111 and the driver pushed
  // since; the head is HEAD_SHA.
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: reviewed at 1111111, reads fine. APPROVE"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false, "an approval of an older head passed the gate");
    assert.match(String(result.refusal), /needs a fresh review/);
    assert.equal(row.status, "claimed");
    assert.equal(row.corrections_count, 0, "a stale approval is not a correction");
  });
});

test("AN APPROVE QUOTING THE CURRENT HEAD passes, as a 7-character prefix or the full sha", async () => {
  for (const quoted of [HEAD_SHA.slice(0, 7), HEAD_SHA, HEAD_SHA.toUpperCase().slice(0, 12)]) {
    const { db, row } = queueDb(claimedRow());
    await withComments([`REVIEW: reviewed at ${quoted}, reads fine. APPROVE`], async () => {
      const result = await finish(db);
      assert.equal(result.ok, true, `an approval quoting ${quoted} was refused: ${JSON.stringify(result)}`);
      assert.equal(row.status, "done");
    });
  }
});

test("A CHANGES QUOTING AN OLDER HEAD STILL SENDS THE JOB BACK, because only APPROVE needs the sha", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: at 1111111 the error path is wrong. CHANGES"], async () => {
    await finish(db);
    assert.equal(row.status, "claimed");
    assert.equal(row.corrections_count, 1, "a CHANGES on an older head was not acted on");
  });
});

test("A 6-CHARACTER PREFIX IS NOT A QUOTED SHA", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments([`REVIEW: reviewed at ${HEAD_SHA.slice(0, 6)}. APPROVE`], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false, "a 6-character prefix counted as the head sha");
    assert.equal(row.status, "claimed");
  });
});

test("PLANT: a pull request in a repo the namespace does not map is refused, and GitHub is not asked about it", async () => {
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  const asked: string[] = [];
  await withGitHub(
    { "*": [`REVIEW: fine at ${SHORT}. APPROVE`] },
    async () => {
      const result = await completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
        result_summary: "opened PR 5",
        result_ref: "https://github.com/someone-else/other-repo/pull/5",
      });
      assert.equal(result.ok, false, "a pull request outside the namespace mapping passed the gate");
      assert.match(String(result.refusal), /is not mapped to namespace capsid/);
      assert.equal(row.status, "claimed");
      assert.equal(row.result_ref, null, "an unmapped pull request must not become the job's bound one");
    },
    { asked }
  );
  assert.deepEqual(asked.filter((u) => u.includes("someone-else")), []);
});

test("THE NORMAL CASE: the job's own pull request, approved at its current head, proceeds and stays bound", async () => {
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  await withGitHub({ "27": [`REVIEW: the scope check is right at ${SHORT}. APPROVE`] }, async () => {
    const result = await finish(db);
    assert.equal(result.ok, true, `an approved job was refused: ${JSON.stringify(result)}`);
    assert.equal(row.status, "done");
    assert.equal(row.result_ref, PR);
  });
});

test("AN UNREADABLE GITHUB HOLDS THE JOB rather than waving it through", async () => {
  // The gate exists to put a second reader in front of the seat. An unreadable comment
  // list is not evidence that one looked, so it must never read as an approval.
  const { db, row } = queueDb(claimedRow());
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream is down", { status: 503 })) as never;
  try {
    const result = await finish(db);
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /GitHub could not be read/);
    assert.match(String(result.refusal), /rather than treating an unreadable review as an approval/);
    assert.equal(row.status, "claimed");
  } finally {
    globalThis.fetch = original;
  }
});
