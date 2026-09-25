import assert from "node:assert/strict";
import { test } from "node:test";
import { settledMinutes } from "../src/improve/ingest.ts";
import { ROSTER, estimatedScorerMinutes, isFreeOfCharge, maxAttemptsFor, meteredMinutes, scheduledFor } from "../src/improve-schema.ts";

// PER-NAMESPACE ATTEMPT CAPS AND THE NIGHTLY ROTATION (ruled 2026-09-15).
//
// One scorer run costs a different number of BILLED minutes in each repo, so one
// global ceiling spent 2.7 times more on foxhound than on germomics for the same
// number of attempts. These pin the two halves of the ruling: what a namespace
// may attempt, and how many billed namespaces may open on one night.

test("every roster namespace has its own attempt cap, and capsid's is the largest because its runs are free", () => {
  const largest = Math.max(...ROSTER.map((ns) => maxAttemptsFor(ns)));
  assert.equal(maxAttemptsFor("capsid"), largest, "capsid does not have the largest cap");

  // The ordering is the point, not the literals: a cheaper namespace may attempt
  // at least as much as a dearer one. Measured billed minutes per run on
  // 2026-09-15: foxhound 7.6, dustinedwards 4.9, foxing 3.9, germomics 2.8.
  assert.ok(maxAttemptsFor("germomics") >= maxAttemptsFor("foxing"), "germomics is cheaper than foxing");
  assert.ok(maxAttemptsFor("foxing") >= maxAttemptsFor("dustinedwards"), "foxing is cheaper than dustinedwards");
  assert.ok(maxAttemptsFor("dustinedwards") >= maxAttemptsFor("foxhound"), "dustinedwards is cheaper than foxhound");
});

test("an off-roster namespace gets the SMALLEST cap, never a default", () => {
  const smallest = Math.min(...ROSTER.map((ns) => maxAttemptsFor(ns)));
  assert.equal(maxAttemptsFor("not-a-namespace"), smallest);
  assert.equal(maxAttemptsFor(""), smallest);
  // Fail closed: a namespace nobody costed must not inherit the free repo's 10.
  assert.ok(maxAttemptsFor("not-a-namespace") < maxAttemptsFor("capsid"));
});

test("exactly ONE billed namespace opens per night, and capsid opens every night", () => {
  const seen = new Set<string>();
  for (let day = 0; day < 8; day += 1) {
    const chosen = scheduledFor(new Date(Date.UTC(2026, 8, 15 + day, 12)));
    assert.ok(chosen.includes("capsid"), `capsid is absent on day ${day}`);
    const billed = chosen.filter((ns) => ns !== "capsid");
    assert.equal(billed.length, 1, `day ${day} opened ${billed.length} billed namespaces, not 1`);
    seen.add(billed[0]!);
  }
  // Eight nights covers the four billed namespaces twice, so the rotation
  // reaches all of them rather than favouring one.
  assert.deepEqual([...seen].sort(), ["dustinedwards", "foxhound", "foxing", "germomics"]);
});

test("the rotation is a pure function of the date, so two reads on one night agree", () => {
  const morning = scheduledFor(new Date("2026-09-15T00:30:00Z"));
  const evening = scheduledFor(new Date("2026-09-15T23:30:00Z"));
  assert.deepEqual(morning, evening);
  // And the next UTC day is a different billed namespace, which is what makes it
  // a rotation rather than a constant.
  const nextDay = scheduledFor(new Date("2026-09-16T12:00:00Z"));
  assert.notDeepEqual(morning, nextDay);
});

// THE MONTHLY METER (ruled 2026-09-15). Two properties, and neither is about how
// long a scorer takes. A repo GitHub bills nothing for contributes nothing, and
// the estimate booked at dispatch is a lien that the report REPLACES rather than
// adds to, so a run is never charged twice.

test("a free repo contributes NOTHING to the meter, however long its scorer took", () => {
  assert.equal(isFreeOfCharge("capsid"), true, "capsid's repo is public");
  assert.equal(estimatedScorerMinutes("capsid"), 0);
  assert.equal(meteredMinutes("capsid", 2.3), 0, "capsid's measured 2.3 wall-clock minutes cost nothing");
  assert.equal(meteredMinutes("capsid", 9999), 0, "no reported figure makes a free repo cost something");
});

test("every BILLED namespace does contribute, and carries a non-zero estimate", () => {
  const billed = ROSTER.filter((n) => !isFreeOfCharge(n));
  assert.ok(billed.length > 0, "no roster namespace is billed, so this checks nothing");
  for (const ns of billed) {
    assert.ok(estimatedScorerMinutes(ns) > 0, `${ns} has no dispatch estimate`);
    assert.equal(meteredMinutes(ns, 4), 4, `${ns} did not meter its reported minutes`);
  }
});

test("an off-roster namespace is charged the LARGEST estimate, never the free repo's zero", () => {
  const largest = Math.max(...ROSTER.map((ns) => estimatedScorerMinutes(ns)));
  assert.equal(estimatedScorerMinutes("not-a-namespace"), largest);
  assert.ok(estimatedScorerMinutes("not-a-namespace") > 0, "an unknown namespace must not be free");
});

test("a negative or unusable reported figure meters as zero, never as a credit", () => {
  assert.equal(meteredMinutes("foxhound", -5), 0);
  assert.equal(meteredMinutes("foxhound", Number.NaN), 0);
  assert.equal(meteredMinutes("foxhound", Number.POSITIVE_INFINITY), 0);
});

test("the dispatch reservation is REPLACED by the report, not added to it", () => {
  // foxhound is billed and its dispatch estimate is 7.6. A run that has just
  // dispatched carries that lien; the report settles it.
  const reserved = estimatedScorerMinutes("foxhound");

  const afterDispatch = { namespace: "foxhound", ci_minutes: reserved };
  assert.equal(settledMinutes(afterDispatch, 5), 5, "the lien was not released");

  // The failure this pins: adding instead of replacing charges the run twice,
  // which would read as 12.6 here.
  assert.notEqual(settledMinutes(afterDispatch, 5), reserved + 5);

  // A second attempt on the same run settles only its own lien, leaving the
  // first attempt's settled minutes alone.
  const secondDispatch = { namespace: "foxhound", ci_minutes: 5 + reserved };
  assert.equal(settledMinutes(secondDispatch, 6), 11);
});

test("PLANT: an unknown scorer duration keeps the reservation instead of booking zero", () => {
  // Audit 2026-09-25, finding 6-6. The scorer reports null when Job A's start time
  // did not arrive, and parseScoreReport reads null as 0. Replacing the lien with
  // meteredMinutes(0) booked a billed run at nothing against the monthly cap.
  const reserved = estimatedScorerMinutes("foxhound");
  const afterDispatch = { namespace: "foxhound", ci_minutes: 3 + reserved };
  for (const unknown of [0, -1, Number.NaN]) {
    assert.equal(settledMinutes(afterDispatch, unknown), 3 + reserved, `a reported ${unknown} released the reservation`);
  }
});

test("settlement never goes negative, so an over-estimate cannot buy back budget", () => {
  const over = { namespace: "foxhound", ci_minutes: 0 };
  assert.equal(settledMinutes(over, 0), 0);
  assert.ok(settledMinutes(over, 1) >= 0);
});
