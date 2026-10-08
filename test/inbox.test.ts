import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedJobItem, restrictInbox, severityOf, type Inbox } from "../src/inbox.ts";

// The pure parts of "what needs Dustin, per app" (job_84e901d8eb71). The queries that feed
// them, and the route, run against a real D1 and the whole Worker in
// test-integration/inbox.test.ts.

test("severity: anything waiting on a person is needs-you, only machine faults are failing, nothing is none", () => {
  assert.equal(severityOf([]), "none");
  assert.equal(severityOf([{ kind: "ci" }]), "failing");
  assert.equal(severityOf([{ kind: "site-down" }, { kind: "ci" }]), "failing");
  assert.equal(severityOf([{ kind: "ci" }, { kind: "blocked-job" }]), "needs-you", "a person's item outranks a failing build");
  assert.equal(severityOf([{ kind: "question" }]), "needs-you");
  assert.equal(severityOf([{ kind: "pr" }]), "needs-you");
});

test("a blocked job is an item with the pull request it names as its link, and a question is marked", () => {
  const plain = blockedJobItem({
    id: "job_a",
    title: "Add the health route",
    result_ref: null,
    result_summary: "Ready. Merge https://github.com/example-org/sample/pull/42 once CI is green.\n\nRun this: ...",
    updated_at: "2026-10-08T10:00:00.000Z",
  });
  assert.deepEqual(plain, { title: "Add the health route", kind: "blocked-job", link: "https://github.com/example-org/sample/pull/42", since: "2026-10-08T10:00:00.000Z" });
  const question = blockedJobItem({ id: "job_b", title: "Choose a name", result_ref: null, result_summary: "QUESTION: Which name?", updated_at: "2026-10-08T11:00:00.000Z" });
  assert.equal(question.kind, "question");
  assert.equal(question.link, null, "no pull request, no link");
});

test("restricting the inbox to readable apps drops the others and recomputes the totals", () => {
  const inbox: Inbox = {
    generated: "2026-10-08T12:00:00.000Z",
    count: 3,
    severity: "needs-you",
    apps: [
      { namespace: "a", name: "A", count: 1, severity: "failing", items: [{ title: "CI is failing", kind: "ci", link: null, since: "2026-10-08T09:00:00.000Z" }] },
      { namespace: "b", name: "B", count: 2, severity: "needs-you", items: [
        { title: "x", kind: "blocked-job", link: null, since: "2026-10-08T09:00:00.000Z" },
        { title: "y", kind: "pr", link: null, since: "2026-10-08T09:30:00.000Z" },
      ] },
    ],
  };
  const onlyA = restrictInbox(inbox, (ns) => ns === "a");
  assert.deepEqual(onlyA.apps.map((a) => a.namespace), ["a"]);
  assert.equal(onlyA.count, 1);
  assert.equal(onlyA.severity, "failing", "b's blocked job no longer counts toward a caller who cannot read b");
  const none = restrictInbox(inbox, () => false);
  assert.deepEqual({ count: none.count, severity: none.severity, apps: none.apps }, { count: 0, severity: "none", apps: [] });
});
