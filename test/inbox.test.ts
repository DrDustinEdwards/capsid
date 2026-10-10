import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedJobItem, restrictInbox, severityOf, type Inbox } from "../src/inbox.ts";
import { MAX_REPORT_ITEMS, MAX_REPORT_TITLE, REPORT_TTL_SECONDS, parseReport, reportItems, spendReportRate } from "../src/inbox-report.ts";
import { fakeKv } from "./fakes.ts";

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

// What an app reports about itself (src/inbox-report.ts; Dustin's answers 2026-10-10). Each
// refusal is a case the route stores nothing for; the route itself, with its scope check and
// rate limit, runs through the whole Worker in test-integration/inbox.test.ts.

const ORIGIN = "https://sample.example.com";
const AT = new Date("2026-10-10T06:00:00.000Z");

test("a report within the contract is read as needs-you items on the app's own origin", () => {
  const out = parseReport({ namespace: "sample", items: [{ title: "Four AI drafts wait for review", link: `${ORIGIN}/drafts`, since: "2026-10-10T05:00:00Z" }, { title: "No link" }] }, ORIGIN, AT);
  assert.ok(out.ok, out.ok ? "" : out.refusal);
  assert.deepEqual(out.value.items, [
    { title: "Four AI drafts wait for review", kind: "report", link: `${ORIGIN}/drafts`, since: "2026-10-10T05:00:00.000Z" },
    { title: "No link", kind: "report", link: null, since: AT.toISOString() },
  ]);
  assert.equal(severityOf(out.value.items), "needs-you", "a reported item always counts as needs-you");
});

test("a report outside the contract is refused whole, for each way it can be outside it", () => {
  const many = Array.from({ length: MAX_REPORT_ITEMS + 1 }, (_, i) => ({ title: `item ${i}` }));
  const cases: [string, unknown, string | null][] = [
    ["a severity field", { namespace: "sample", items: [], severity: "none" }, ORIGIN],
    ["a severity on an item", { namespace: "sample", items: [{ title: "x", severity: "none" }] }, ORIGIN],
    ["too many items", { namespace: "sample", items: many }, ORIGIN],
    ["a long title", { namespace: "sample", items: [{ title: "x".repeat(MAX_REPORT_TITLE + 1) }] }, ORIGIN],
    ["an empty title", { namespace: "sample", items: [{ title: "  " }] }, ORIGIN],
    ["a link on another origin", { namespace: "sample", items: [{ title: "x", link: "https://elsewhere.example.com/drafts" }] }, ORIGIN],
    ["a look-alike host", { namespace: "sample", items: [{ title: "x", link: "https://sample.example.com.evil.example/drafts" }] }, ORIGIN],
    ["an http link", { namespace: "sample", items: [{ title: "x", link: "http://sample.example.com/drafts" }] }, ORIGIN],
    ["credentials in the link", { namespace: "sample", items: [{ title: "x", link: "https://user@sample.example.com/drafts" }] }, ORIGIN],
    ["a link from a namespace with no site", { namespace: "sample", items: [{ title: "x", link: `${ORIGIN}/drafts` }] }, null],
    ["a bad since", { namespace: "sample", items: [{ title: "x", since: "yesterday" }] }, ORIGIN],
    ["items that are not an array", { namespace: "sample", items: "four" }, ORIGIN],
  ];
  for (const [name, body, origin] of cases) assert.equal(parseReport(body, origin, AT).ok, false, `${name} was accepted`);
});

test("a stored report counts until it is 6 hours old, and not after", () => {
  const raw = JSON.stringify({ namespace: "sample", reported_at: AT.toISOString(), reported_by: "agent:sample-app", items: [{ title: "x", kind: "report", link: null, since: AT.toISOString() }] });
  const later = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
  assert.equal(reportItems(raw, later(REPORT_TTL_SECONDS)).length, 1, "a report exactly 6 hours old still counts");
  assert.equal(reportItems(raw, later(REPORT_TTL_SECONDS + 1)).length, 0, "a report over 6 hours old still counted");
  assert.equal(reportItems("{{", AT).length, 0, "a malformed value reads as none");
});

test("one report per minute per key, and an unreadable counter refuses", async () => {
  const kv = fakeKv({}).kv;
  assert.deepEqual(await spendReportRate(kv, "agent:sample-app"), { ok: true });
  const second = await spendReportRate(kv, "agent:sample-app");
  assert.equal(second.ok ? 0 : second.status, 429);
  assert.deepEqual(await spendReportRate(kv, "agent:other-app"), { ok: true }, "the limit is per key");
  const broken = { get: async () => { throw new Error("kv down"); }, put: async () => undefined } as unknown as KVNamespace;
  const down = await spendReportRate(broken, "agent:sample-app");
  assert.equal(down.ok ? 0 : down.status, 503, "the counter failed open");
});
