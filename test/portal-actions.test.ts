import assert from "node:assert/strict";
import { test } from "node:test";
import { handlePortalPerform, handlePortalPreview } from "../src/portal-actions.ts";
import { PORTAL_ACTIONS } from "../src/controls-base.ts";
import {
  NOW,
  EMAIL,
  ACTOR,
  LATER,
  world,
  preview,
  perform,
  deps,
  wroteNothing,
  spentOnly,
  previewOk,
  doPerform,
  forge,
  EVERY_ACTION,
  auditRows,
} from "./portal-actions-fixtures.ts";

// The Portal's controls (src/portal-actions.ts): a preview that writes nothing and
// signs what it previewed, then a perform that carries only that token. The job
// transitions themselves are driven through the Worker against real D1 in
// test-integration/portal-actions.test.ts; these cover the checks in front of them.

// The absences

test("PLANT: a merge or a mint is refused at preview and at perform, even fully signed, and writes nothing", async () => {
  for (const action of ["merge", "manage_pr", "mint", "mint_agent"]) {
    assert.ok(
      !(PORTAL_ACTIONS as readonly string[]).includes(action),
      `PORTAL_ACTIONS includes ${action}`,
    );
    const w = world();
    const res = await handlePortalPreview(await preview({ action, params: {} }), w.env, NOW);
    assert.equal(res.status, 400, `${action} was not refused as an unknown action`);
    assert.match(await res.text(), /deliberately not among them/);
    wroteNothing(w, `${action} preview`);

    const token = await forge({
      action,
      params: {},
      email: EMAIL,
    });
    const performed = await doPerform(w, token);
    assert.equal(performed.status, 400, `a signed ${action} token was performed`);
    // Redeeming spends the token before its action is looked up, so only its nonce is written.
    spentOnly(w, `${action} perform`);
  }
});

test("every loop below covers each Portal action", () => {
  assert.deepEqual(EVERY_ACTION.map(([action]) => action).sort(), [...PORTAL_ACTIONS].sort());
});

// The CSRF pair is checked in the gate before the action is read, so one action stands for all.
for (const [label, opts] of [
  ["with no CSRF header", { csrfHeader: null }],
  [
    "when the CSRF header does not match the cookie",
    { csrfHeader: "ffffffff-2222-4333-8444-555555555555" },
  ],
  ["when there is no CSRF cookie", { csrfCookie: null }],
] as const) {
  test(`preview REFUSES ${label}, and writes nothing`, async () => {
    const w = world();
    const params = { value: "api", reason: "x" };
    const res = await handlePortalPreview(
      await preview({ action: "overnight", params }, opts),
      w.env,
      NOW,
    );
    assert.equal(res.status, 403);
    assert.match(await res.text(), /csrf validation failed/);
    wroteNothing(w, "overnight");
  });
}

// Every action: a preview that states what will change, signs it, and writes nothing
for (const [action, params] of EVERY_ACTION) {
  // namespace_remove's plan is the delete's reader, json_each and all, which the node fake
  // does not evaluate (test/namespace-delete.test.ts); its preview and perform run against
  // real D1 in test-integration/portal-actions.test.ts.
  if (action === "namespace_remove") continue;
  test(`PLANT: ${action} preview states what will change, signs it, and writes NOTHING`, async () => {
    const w = world();
    const body = await previewOk(w, action, params);
    assert.equal(body.action, action);
    assert.ok(body.summary.length > 20, "no summary");
    assert.ok(
      body.changes.length >= 1 && body.changes.every((c) => c.length > 10),
      `no concrete changes: ${JSON.stringify(body.changes)}`,
    );
    assert.ok(
      body.audit.includes(`portal-${action} by ${ACTOR}`),
      `the click row is not in the preview's audit list: ${JSON.stringify(body.audit)}`,
    );
    assert.equal(body.audit.length, 2, "the mutator's row and the click row");
    assert.match(body.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(body.expires_at, LATER(5 * 60_000).toISOString());
    wroteNothing(w, `${action} preview`);
  });
}

// The concrete lines, where they name what the state holds now

test("a resume preview says the job goes to the queue, and why, when its claimant is a shared identity", async () => {
  const w = world();
  w.d1.rows.jobs[0].claimed_by = "access:admin@example.com";
  const body = await previewOk(w, "resume_job", { id: "job_blocked00001", reason: "ran the push" });
  assert.match(body.changes[0], /blocked -> queued/);
  assert.match(body.changes[0], /access:admin@example.com is a shared identity/);
});

// Preview refusals against the current state

test("preview refuses what the mutator would refuse, and writes nothing", async () => {
  for (const [action, params, pattern] of [
    ["overnight", { value: "banana", reason: "x" }, /banana/],
    ["overnight", { value: "api" }, /needs a reason/],
    ["reset_breaker", { namespace: "nosuch" }, /not on the roster/],
    ["resume_job", { id: "job_queued000001", reason: "x" }, /not blocked/],
    ["release_job", { id: "job_blocked00001", reason: "x" }, /not claimed/],
    [
      "supersede_job",
      { id: "job_blocked00001", reason: "x" },
      /a blocked job has hit a gate, so it is failed instead/,
    ],
    [
      "supersede_job",
      { id: "job_queued000001", reason: "x", replaced_by: "job_queued000001" },
      /cannot be replaced by itself/,
    ],
    ["park_job", { id: "job_queued000001", reason: "two\nlines" }, /in one line/],
    ["pr_close", { namespace: "nosuch", number: "41", reason: "x" }, /unknown namespace: nosuch/],
    ["fail_job", { id: "job_missing00001", reason: "x" }, /no job job_missing00001/],
    ["overnight", { value: "api", reason: "x", extra: "y" }, /'extra' is not one of them/],
  ] as const) {
    const w = world();
    const res = await handlePortalPreview(await preview({ action, params }), w.env, NOW);
    assert.equal(res.status, 400, `${action} ${JSON.stringify(params)} was not refused`);
    assert.match(await res.text(), pattern);
    wroteNothing(w, `${action} refused preview`);
  }
});

// The automation switches: a reason in both directions, and an Undo that says so

const SWITCH_CASES = [
  ["overnight", { value: "api" }],
  ["overnight", { value: "subscription" }],
] as const;

test("PLANT: overnight REFUSES a missing or blank reason at preview, and writes nothing", async () => {
  for (const [action, params] of SWITCH_CASES) {
    for (const reason of [undefined, "   "]) {
      const w = world();
      const res = await handlePortalPreview(
        await preview({ action, params: reason === undefined ? params : { ...params, reason } }),
        w.env,
        NOW,
      );
      assert.equal(res.status, 400, `${action} previewed with reason ${JSON.stringify(reason)}`);
      assert.match(await res.text(), new RegExp(`^${action} needs a reason`));
      wroteNothing(w, `${action} with no reason`);
    }
  }
});

test("PLANT: a signed switch token with no reason (issued before the rule) is refused at perform and changes nothing", async () => {
  for (const [action, params] of SWITCH_CASES) {
    const w = world();
    const token = await forge({
      action,
      params,
      email: EMAIL,
    });
    const res = await doPerform(w, token);
    assert.equal(res.status, 400, `${action} with no reason was performed`);
    assert.match(await res.text(), /needs a reason/);
    spentOnly(w, `${action} perform with no reason`);
  }
});

test("PLANT: a click row records the address the click came from, and null when there is none", async () => {
  for (const [action, params] of SWITCH_CASES) {
    for (const [header, recorded] of [
      ["203.0.113.7", "203.0.113.7"],
      ["2001:db8::7", "2001:db8::7"],
      [null, null],
    ] as const) {
      const w = world();
      const { token } = await previewOk(w, action, { ...params, reason: "from somewhere" });
      const req = await perform({ token });
      if (header) req.headers.set("CF-Connecting-IP", header);
      const res = await handlePortalPerform(req, w.env, NOW, deps);
      assert.equal(res.status, 200, await res.clone().text());
      const click = w.d1.recorded.find((r) => r.params[1] === `portal-${action}`);
      assert.ok(click, `${action} wrote no click row`);
      const detail = JSON.parse(String(click.params[4])) as Record<string, unknown>;
      assert.ok("source_address" in detail, `${action}'s click row has no source_address at all`);
      assert.equal(detail.source_address, recorded, `${action} with ${header}`);
    }
  }
});

test("PLANT: an Undo previews and writes portal-undo-<action>, its own row, never portal-<action>", async () => {
  for (const [action, params] of SWITCH_CASES) {
    const w = world();
    const reason = "Undo: a mistaken flip";
    const body = await previewOk(w, action, { ...params, reason, undo: "true" });
    assert.ok(
      body.audit.includes(`portal-undo-${action} by ${ACTOR}`),
      `${action}'s undo preview does not list its own row: ${JSON.stringify(body.audit)}`,
    );
    assert.ok(
      !body.audit.includes(`portal-${action} by ${ACTOR}`),
      `${action}'s undo preview lists the plain click row`,
    );
    assert.match(body.summary, /^Undo: /);
    wroteNothing(w, `${action} undo preview`);
    const res = await handlePortalPerform(await perform({ token: body.token }), w.env, NOW, deps);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(auditRows(w.d1).sort(), [...body.audit].sort());
    const click = w.d1.recorded.find((r) => r.params[1] === `portal-undo-${action}`);
    assert.equal(click?.params[0], ACTOR);
    const detail = JSON.parse(String(click?.params[4])) as Record<string, unknown>;
    assert.equal(detail.undo, true);
    assert.equal(detail.reason, reason);
  }
});
