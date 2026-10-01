import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDetail } from "../src/audit-detail.ts";

// What an audit row recorded, as the Activity drawer shows it (src/audit-detail.ts):
// the reason, a field-by-field before and after, the other fields by name, and never a
// hash, a signature or a nested value.

const MARKER = "PLANTED-SECRET-5b1e";

test("a switch's click row reads as its reason and its named fields", () => {
  const d = auditDetail(JSON.stringify({ mode: "off", reason: "Budget resets Friday.", undo: true }));
  assert.equal(d.reason, "Budget resets Friday.");
  assert.equal(d.changes, null);
  assert.deepEqual(d.fields, [
    { name: "Mode", value: "off" },
    { name: "Undo of a change just made", value: "yes" },
  ]);
  assert.equal(d.withheld, 0);
});

test("PLANT: an edit lists only the fields that changed, the old value beside the new", () => {
  const before = { namespace: "sample", origin: "https://sample.example.com", health_path: null, revision: 3, platform: "cloudflare" };
  const after = { namespace: "sample", origin: "https://www.sample.example.com", health_path: "/health", revision: 4, platform: "cloudflare" };
  const d = auditDetail(JSON.stringify({ before, after }));
  assert.deepEqual(d.changes, [
    { field: "Origin", before: "https://sample.example.com", after: "https://www.sample.example.com" },
    { field: "Health path", before: "none", after: "/health" },
    { field: "Revision", before: "3", after: "4" },
  ]);
  assert.deepEqual(d.fields, [], "before and after are shown as the diff, not again as fields");
});

test("an add lists every field as new, and a remove every field as gone", () => {
  const added = auditDetail(JSON.stringify({ after: { name: "sample-pkg", repo: "example/sample" } }));
  assert.deepEqual(added.changes, [
    { field: "Name", before: null, after: "sample-pkg" },
    { field: "Repo", before: null, after: "example/sample" },
  ]);
  const removed = auditDetail(JSON.stringify({ before: { name: "sample-pkg" } }));
  assert.deepEqual(removed.changes, [{ field: "Name", before: "sample-pkg", after: null }]);
});

test("PLANT: a hash, a signature, a token or a nested value is never shown, only counted", () => {
  const params = {
    sha256: MARKER,
    body_sha256: MARKER,
    summary_sig: MARKER,
    token: MARKER,
    api_key: MARKER,
    nested: { inner: MARKER },
    list: [{ inner: MARKER }],
    before: { origin: "a", content_hash: MARKER },
    after: { origin: "b", content_hash: MARKER + "2" },
    merge_sha: "abc1234",
  };
  const d = auditDetail(JSON.stringify(params));
  assert.doesNotMatch(JSON.stringify(d), new RegExp(MARKER), "a withheld value reached the detail");
  assert.deepEqual(d.fields, [{ name: "Merge sha", value: "abc1234" }]);
  assert.deepEqual(d.changes, [{ field: "Origin", before: "a", after: "b" }]);
  assert.equal(d.withheld, 8);
});

test("a list of scalars is one line; an empty list is none; a long value is capped", () => {
  const d = auditDetail(JSON.stringify({ posted: ["site-down-a", "ci-red-b"], cleared: [], note: "x".repeat(900) }));
  assert.deepEqual(d.fields.slice(0, 2), [
    { name: "Findings posted", value: "site-down-a, ci-red-b" },
    { name: "Findings cleared", value: "none" },
  ]);
  assert.equal(d.fields[2]?.value.length, 300);
});

test("params that are not JSON are unreadable, said, not guessed at", () => {
  assert.deepEqual(auditDetail("not json {"), { reason: null, changes: null, fields: [], withheld: 0, unreadable: true });
  assert.deepEqual(auditDetail(null), { reason: null, changes: null, fields: [], withheld: 0, unreadable: false });
});

test("a blank reason is no reason, and stays out of the fields", () => {
  const d = auditDetail(JSON.stringify({ reason: "   ", id: "job_0000000000aa" }));
  assert.equal(d.reason, null);
  assert.deepEqual(d.fields, [{ name: "Id", value: "job_0000000000aa" }]);
});
