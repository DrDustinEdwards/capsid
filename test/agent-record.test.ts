import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordFor,
  recordsFrom,
  type RecordRows,
  type RecordSubject,
} from "../src/agent-record.ts";

// The agent record: counts and rates over the outcome rows, tested as a pure function
// over fixtures, because a denominator that counts the wrong rows still produces a
// plausible percentage.

const ACTOR = "agent:capsid-driver";

function outcome(
  overrides: Partial<RecordRows["outcomes"][number]> = {},
): RecordRows["outcomes"][number] {
  return {
    agent: ACTOR,
    prs_opened: null,
    prs_merged: null,
    ci_green: null,
    blocked_count: 0,
    resumed_count: 0,
    duration_minutes: null,
    verified: JSON.stringify({
      prs_opened: false,
      prs_merged: false,
      commits: false,
      files_changed: false,
      ci_green: false,
    }),
    ...overrides,
  };
}

function verified(overrides: Partial<RecordRows["outcomes"][number]> = {}) {
  return outcome({
    verified: JSON.stringify({
      prs_opened: true,
      prs_merged: true,
      commits: true,
      files_changed: true,
      ci_green: true,
    }),
    ...overrides,
  });
}

const EMPTY: RecordRows = { outcomes: [], jobs: [] };

test("a credential that has done nothing reports zero counts and NULL rates", () => {
  // A count of zero is a fact: this agent finished no jobs. A rate of zero would claim
  // a bad record, and it has no record.
  const record = recordFor(ACTOR, EMPTY);
  assert.equal(record.jobs_done, 0);
  assert.equal(record.prs_opened, 0);
  assert.equal(record.pr_merge_rate, null);
  assert.equal(record.ci_green_rate, null);
  assert.equal(record.median_duration_minutes, null);
  assert.equal(record.actor, ACTOR);
});

test("job states come from the jobs table, because a blocked job has no outcome yet", () => {
  const record = recordFor(ACTOR, {
    ...EMPTY,
    jobs: [
      { actor: ACTOR, status: "done", n: 5 },
      { actor: ACTOR, status: "failed", n: 2 },
      { actor: ACTOR, status: "blocked", n: 1 },
      { actor: "agent:sample-driver", status: "done", n: 40 },
      // A bare name is a different caller. The queue records agent:<name>, and
      // matching the name alone would credit somebody else's work.
      { actor: "capsid-driver", status: "done", n: 99 },
    ],
  });
  assert.equal(record.jobs_done, 5);
  assert.equal(record.jobs_failed, 2);
  assert.equal(record.jobs_blocked, 1);
});

test("ONLY A VERIFIED FIELD FEEDS A RATE", () => {
  // An unverified count is stored on its row; a rate built from it would be a
  // credential grading its own work.
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      // Unverified and generous: forty opened, forty merged. If this counted, the
      // merge rate would be a perfect 100%.
      outcome({ prs_opened: 40, prs_merged: 40 }),
      verified({ prs_opened: 4, prs_merged: 1 }),
    ],
  });
  assert.equal(record.prs_opened, 4, "an unverified pull request count reached the record");
  assert.equal(record.prs_merged, 1);
  assert.equal(record.pr_merge_rate, 0.25);
});

test("the CI rate's denominator is what was checked, not what was done", () => {
  // A documentation job has no build. Counting it as a CI miss would mark an agent
  // down for work that never had CI to be green.
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      verified({ ci_green: 1 }),
      verified({ ci_green: 1 }),
      verified({ ci_green: 0 }),
      outcome({ ci_green: null }),
      outcome({ ci_green: null }),
      verified({ ci_green: null }),
    ],
  });
  assert.equal(record.ci_checked, 3, "the denominator counted rows the Worker never checked");
  assert.equal(record.ci_green_rate, 0.667);
});

test("the duration is a MEDIAN, so one job left open over a weekend does not move it", () => {
  const weekend = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      outcome({ duration_minutes: 20 }),
      outcome({ duration_minutes: 25 }),
      outcome({ duration_minutes: 30 }),
      outcome({ duration_minutes: 4000 }),
    ],
  });
  // The mean here is over a thousand minutes. The median says what a job usually took.
  assert.equal(weekend.median_duration_minutes, 28);
  const odd = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      outcome({ duration_minutes: 1 }),
      outcome({ duration_minutes: 5 }),
      outcome({ duration_minutes: 90 }),
    ],
  });
  assert.equal(odd.median_duration_minutes, 5);
  const mixed = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [outcome({ duration_minutes: null }), outcome({ duration_minutes: 10 })],
  });
  assert.equal(mixed.median_duration_minutes, 10);
});

test("gates hit and resumes are totals over the agent's own rows", () => {
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [
      outcome({ blocked_count: 2, resumed_count: 2 }),
      outcome({ blocked_count: 1, resumed_count: 1 }),
      outcome({ agent: "agent:sample-driver", blocked_count: 9, resumed_count: 9 }),
    ],
  });
  assert.equal(record.gates_hit, 3);
  assert.equal(record.resumed, 3);
});

test("a corrupt verified column withholds a rate rather than inventing one", () => {
  // Fail closed, which for a rate means refusing to compute it. The alternative is a
  // percentage derived from a column nobody can read.
  for (const bad of ["{", "null", "[]", '"true"']) {
    const record = recordFor(ACTOR, {
      ...EMPTY,
      outcomes: [outcome({ prs_opened: 9, prs_merged: 9, verified: bad })],
    });
    assert.equal(record.prs_opened, 0, `a row with a ${bad} verified column was counted`);
    assert.equal(record.pr_merge_rate, null);
  }
});

test("recordsFrom keys by agent name", () => {
  const agents: RecordSubject[] = [
    { name: "capsid-driver", kind: "driver", namespaces: ["capsid"] },
    { name: "seat", kind: "seat", namespaces: "*" },
  ];
  const records = recordsFrom(agents, {
    outcomes: [verified({ prs_opened: 2, prs_merged: 2 })],
    jobs: [{ actor: ACTOR, status: "done", n: 3 }],
  });
  assert.equal(records["capsid-driver"].jobs_done, 3);
  assert.equal(records["capsid-driver"].pr_merge_rate, 1);
  // The seat gets a record too, and it is empty rather than absent: a credential
  // that has done nothing should read as nothing, not as missing.
  assert.equal(records["seat"].jobs_done, 0);
  // Object.create(null), so a credential named for a prototype member cannot collide
  // with one.
  assert.equal(Object.getPrototypeOf(records), null);
});

// Numerator and denominator must use the same rows: a row whose merge count is not
// yet verified must not pull the rate down.
test("the merge rate counts only rows where both counts were verified", () => {
  const openedOnly = outcome({
    prs_opened: 4,
    prs_merged: 4,
    verified: JSON.stringify({
      prs_opened: true,
      prs_merged: false,
      commits: true,
      files_changed: true,
      ci_green: true,
    }),
  });
  const record = recordFor(ACTOR, {
    ...EMPTY,
    outcomes: [verified({ prs_opened: 2, prs_merged: 2 }), openedOnly],
  });
  assert.equal(record.pr_merge_rate, 1, "a row with an unverified merge count lowered the rate");
});
