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
} from "./portal-actions-fixtures.ts";

// A preview writes nothing and signs what it previewed; a perform carries only that token.
// The site, package and namespace actions run against real D1 in test-integration/portal-actions.test.ts.

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
    const params = { name: "capsid-driver" };
    const res = await handlePortalPreview(
      await preview({ action: "revoke_agent", params }, opts),
      w.env,
      NOW,
    );
    assert.equal(res.status, 403);
    assert.match(await res.text(), /csrf validation failed/);
    wroteNothing(w, "revoke_agent");
  });
}

for (const [action, params] of EVERY_ACTION) {
  // namespace_remove's plan reads through json_each, which the node fake does not evaluate;
  // it runs against real D1 in test-integration/portal-actions.test.ts.
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

test("preview refuses what the mutator would refuse, and writes nothing", async () => {
  for (const [action, params, pattern] of [
    ["pr_close", { namespace: "nosuch", number: "41", reason: "x" }, /unknown namespace: nosuch/],
    ["pr_close", { namespace: "capsid", number: "41" }, /needs a reason/],
    ["revoke_agent", { name: "nosuch" }, /no agent named 'nosuch'/],
    ["revoke_agent", { name: "capsid-driver", extra: "y" }, /'extra' is not one of them/],
  ] as const) {
    const w = world();
    const res = await handlePortalPreview(await preview({ action, params }), w.env, NOW);
    assert.equal(res.status, 400, `${action} ${JSON.stringify(params)} was not refused`);
    assert.match(await res.text(), pattern);
    wroteNothing(w, `${action} refused preview`);
  }
});

test("PLANT: a signed pr_close token with no reason is refused at perform and changes nothing", async () => {
  const w = world();
  const token = await forge({
    action: "pr_close",
    params: { namespace: "capsid", number: "41" },
    email: EMAIL,
  });
  const res = await doPerform(w, token);
  assert.equal(res.status, 400, "pr_close with no reason was performed");
  assert.match(await res.text(), /needs a reason/);
  spentOnly(w, "pr_close perform with no reason");
});

test("PLANT: a click row records the address the click came from, and null when there is none", async () => {
  for (const [header, recorded] of [
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8::7", "2001:db8::7"],
    [null, null],
  ] as const) {
    const w = world();
    const { token } = await previewOk(w, "revoke_agent", { name: "capsid-driver" });
    const req = await perform({ token });
    if (header) req.headers.set("CF-Connecting-IP", header);
    const res = await handlePortalPerform(req, w.env, NOW, deps);
    assert.equal(res.status, 200, await res.clone().text());
    const click = w.d1.recorded.find((r) => r.params[1] === "portal-revoke_agent");
    assert.ok(click, "revoke_agent wrote no click row");
    const detail = JSON.parse(String(click.params[4])) as Record<string, unknown>;
    assert.ok("source_address" in detail, "the click row has no source_address at all");
    assert.equal(detail.source_address, recorded, `with ${header}`);
  }
});
