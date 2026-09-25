import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIRROR_DUMP_PREFIX,
  MIRROR_STALE_HOURS,
  mirrorFindings,
  newestDump,
  parseDumpStamp,
  type MirrorRun,
} from "../src/watcher.ts";
import { BACKUP_STALE_HOURS } from "../src/health.ts";

// THE OFF-ACCOUNT MIRROR WENT DARK FOR FOUR DAYS AND NOTHING REPORTED IT.
//
// 2026-09-09 to 2026-09-12. The mirror had run twice ever, then `node --test test/`
// started failing on Node 24 and the commit step was skipped on every scheduled run.
// The dumps stayed in R2; what stopped was the off-account copy.
//
// TWO EARLIER VERSIONS OF THIS CHECK WOULD NOT HAVE CAUGHT IT, and that is what these
// tests are shaped around. Both keyed on a verified POST /backup/credential. On run
// 34696901751 the mirror's credential step concluded SUCCESS and the run failed two
// steps later, so the Worker saw a healthy request on every dead day. A credential
// request proves the mirror started. Only a dump proves a backup exists.
//
// So the dump age decides WHETHER and the run conclusion explains WHY, and the three
// states are kept apart because they call for three different actions.

const NOW = new Date("2026-09-13T14:00:00Z");
const entry = (name: string) => ({ path: `${MIRROR_DUMP_PREFIX}/${name}` });
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// The mirror's own runs as ciStatus returns them, including a squash run, because
// that repo has two workflows and only one of them is this check's business.
const failedRun: MirrorRun = {
  name: "mirror",
  status: "completed",
  conclusion: "failure",
  created_at: "2026-09-12T13:36:36Z",
  url: "https://github.com/DrDustinEdwards/capsid-backups/actions/runs/34696901751",
};
const greenRun: MirrorRun = { name: "mirror", status: "completed", conclusion: "success", created_at: "2026-09-13T04:24:00Z", url: "https://example/run" };
const squashRun: MirrorRun = { name: "squash", status: "completed", conclusion: "success", created_at: "2026-09-13T05:00:00Z", url: "https://example/squash" };

// ---- the stamp parser ----------------------------------------------------------

test("a dump directory name parses to its own timestamp", () => {
  const at = parseDumpStamp("2026-09-12T09-00-11-132Z");
  assert.ok(at);
  assert.equal(at.toISOString(), "2026-09-12T09:00:11.132Z");
});

test("anything that is not a dump stamp parses to null, not to a date", () => {
  // The failure this prevents: a stray directory read as a fresh backup, which would
  // silence the check permanently and look like health.
  for (const name of ["", "README.md", "2026-09-12", "latest", "2026-09-12T09-00-11Z", "backups", "2026-13-45T99-99-99-999Z"]) {
    assert.equal(parseDumpStamp(name), null, `${name} parsed as a dump stamp`);
  }
});

test("newestDump takes the newest and ignores what does not parse", () => {
  const newest = newestDump([
    entry("2026-09-10T09-00-13-559Z"),
    entry("2026-09-12T09-00-11-132Z"),
    entry("2026-09-11T09-00-42-633Z"),
    entry("README.md"),
    { path: undefined },
  ]);
  assert.ok(newest);
  assert.equal(newest.toISOString(), "2026-09-12T09:00:11.132Z");
});

test("newestDump over nothing parseable is null, which is a different fact from old", () => {
  assert.equal(newestDump([]), null);
  assert.equal(newestDump([entry("README.md"), entry("scripts")]), null);
});

// ---- the three states ------------------------------------------------------------

test("REPLAY OF THE 2026-09-09 INCIDENT: stale dump plus a failed run is finding (a)", () => {
  // The exact shape of the outage. The credential step succeeded throughout, which is
  // why it is deliberately absent from this check's inputs: it was the signal that
  // lied. Newest dump is 2026-09-08, the run conclusion is failure.
  const found = mirrorFindings("capsid", new Date("2026-09-08T09:01:10.703Z"), [failedRun], NOW);
  assert.equal(found.length, 1);
  assert.match(found[0].fingerprint, /^mirror-run-failed-failure$/);
  const body = found[0].body;
  assert.match(body, /failure/);
  assert.match(body, /34696901751/, "the finding does not name the run to look at");
  assert.match(body, /no backup landed/);
});

test("finding (b): stale dump and no completed mirror run at all", () => {
  const found = mirrorFindings("capsid", hoursAgo(50), [], NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "mirror-not-running");
  assert.match(found[0].body, /disabled schedule|archived/i);
});

test("finding (c): GREEN and no new dump, the one a conclusion-first check cannot see", () => {
  const found = mirrorFindings("capsid", hoursAgo(50), [greenRun], NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "mirror-green-no-dump");
  assert.match(found[0].body, /ran green and no new dump|no-ops/i);
});

test("a fresh dump produces NOTHING, whatever the runs say", () => {
  // The healthy case, and the direction that matters most: a check that fires on a
  // working mirror gets switched off rather than fixed.
  assert.deepEqual(mirrorFindings("capsid", hoursAgo(1), [greenRun], NOW), []);
  assert.deepEqual(mirrorFindings("capsid", hoursAgo(1), [failedRun], NOW), []);
  assert.deepEqual(mirrorFindings("capsid", hoursAgo(1), [], NOW), []);
});

test("the window is a boundary, not a vibe", () => {
  assert.deepEqual(mirrorFindings("capsid", hoursAgo(MIRROR_STALE_HOURS - 0.1), [greenRun], NOW), []);
  assert.equal(mirrorFindings("capsid", hoursAgo(MIRROR_STALE_HOURS + 0.1), [greenRun], NOW).length, 1);
});

test("no dump at all is its own finding, not a very old one", () => {
  const found = mirrorFindings("capsid", null, [greenRun], NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "mirror-no-dump");
  assert.match(found[0].body, /never succeeded|layout changed/i);
});

test("another workflow in the same repo is not mistaken for the mirror", () => {
  // capsid-backups also runs squash.yml. A green squash must not report the mirror as
  // green, and must not stand in for a mirror run that never happened.
  const found = mirrorFindings("capsid", hoursAgo(50), [squashRun], NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "mirror-not-running", "a squash run was read as a mirror run");
});

test("an in-flight mirror run is not an answer yet", () => {
  const running: MirrorRun = { name: "mirror", status: "in_progress", conclusion: null, created_at: "2026-09-13T13:00:00Z" };
  const found = mirrorFindings("capsid", hoursAgo(50), [running], NOW);
  assert.equal(found[0].fingerprint, "mirror-not-running");
});

// ---- the wiring ------------------------------------------------------------------

test("the window is its own constant and not the local backup's", () => {
  // Two different things measured from two different sides. One constant standing for
  // both goes wrong silently the day the other repo changes its schedule.
  assert.notEqual(MIRROR_STALE_HOURS, BACKUP_STALE_HOURS);
  assert.ok(MIRROR_STALE_HOURS > 24, "a window under a day fires every morning before the mirror has run");
});

// That the mirror repo is resolved through the namespace's backups label, and never
// named in code, is driven through gatherFindings in test/watcher-gather.test.ts with
// the label mapped to a repo of another name.

// That an unreadable mirror listing posts nothing, and a readable empty one posts
// mirror-no-dump, is driven through gatherFindings in test/watcher-gather.test.ts.

