import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handlePortalPerform,
  handlePortalPreview,
  handlePortalSignOut,
  PORTAL_SIGN_OUT_PATH,
} from "../src/portal-actions.ts";
import {
  NOW,
  EMAIL,
  world,
  post,
  preview,
  perform,
  deps,
  wroteNothing,
  spentOnly,
  previewOk,
  doPerform,
  forge,
} from "./portal-actions-fixtures.ts";

// Every action previews and performs against real D1 in test-integration/portal-actions.test.ts.

test("PLANT: an action the Portal does not offer is refused at preview, and a signed token for one at perform", async () => {
  const w = world();
  const res = await handlePortalPreview(await preview({ action: "merge", params: {} }), w.env, NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /deliberately not among them/);
  wroteNothing(w, "merge preview");
  for (const [claims, pattern] of [
    [{ action: "mint_agent", params: {} }, /deliberately not among them/],
    [{ action: "pr_close", params: { namespace: "capsid", number: "41" } }, /needs a reason/],
  ] as const) {
    const signed = world();
    const performed = await doPerform(signed, await forge({ ...claims, email: EMAIL }));
    assert.equal(performed.status, 400, claims.action);
    assert.match(await performed.text(), pattern);
    // Redeeming spends the token before its action is looked up, so only its nonce is written.
    spentOnly(signed, `${claims.action} perform`);
  }
});

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

test("PLANT: preview and sign out refuse a missing or mismatched CSRF pair or another site, and change nothing", async () => {
  const routes = [
    [
      "preview",
      async (opts: object, env: never) =>
        handlePortalPreview(
          await preview({ action: "revoke_agent", params: { name: "capsid-driver" } }, opts),
          env,
          NOW,
        ),
    ],
    [
      "sign out",
      async (opts: object, env: never) =>
        handlePortalSignOut(await post(PORTAL_SIGN_OUT_PATH, {}, opts), env, NOW),
    ],
  ] as const;
  for (const [route, call] of routes)
    for (const [label, opts] of [
      ["no CSRF header", { csrfHeader: null }],
      ["a CSRF header that does not match", { csrfHeader: "ffffffff-2222-4333-8444-555555555555" }],
      ["no CSRF cookie", { csrfCookie: null }],
      ["Sec-Fetch-Site cross-site", { site: "cross-site" }],
    ] as const) {
      const w = world();
      const res = await call(opts, w.env);
      assert.equal(res.status, 403, `${route} with ${label}`);
      assert.equal(res.headers.get("Set-Cookie"), null, `${route} with ${label} set a cookie`);
      wroteNothing(w, `${route} with ${label}`);
    }
});

test("PLANT: a click row records the address the click came from, and null when there is none", async () => {
  for (const [header, recorded] of [
    ["203.0.113.7", "203.0.113.7"],
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
