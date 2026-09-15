import assert from "node:assert/strict";
import { test } from "node:test";
import { ROSTER, maxAttemptsFor, scheduledFor } from "../src/improve-schema.ts";

// PER-NAMESPACE ATTEMPT CAPS AND THE NIGHTLY ROTATION (ruled 2026-09-15).
//
// One scorer run costs a different number of BILLED minutes in each repo, so one
// global ceiling spent 2.7 times more on foxhound than on germomics for the same
// number of attempts. These pin the two halves of the ruling: what a namespace
// may attempt, and how many billed namespaces may open on one night.

test("every roster namespace has its own attempt cap, and capsid's is the largest because its runs are free", () => {
  const caps = Object.fromEntries(ROSTER.map((ns) => [ns, maxAttemptsFor(ns)]));
  assert.deepEqual(caps, { capsid: 10, dustinedwards: 2, foxhound: 2, foxing: 3, germomics: 3 });

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

test("every namespace the rotation can name is on the roster", () => {
  for (let day = 0; day < 12; day += 1) {
    for (const ns of scheduledFor(new Date(Date.UTC(2026, 8, 1 + day, 12)))) {
      assert.ok((ROSTER as readonly string[]).includes(ns), `${ns} is not on the roster`);
    }
  }
});
