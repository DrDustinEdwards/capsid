import assert from "node:assert/strict";
import { test } from "node:test";
import { PORTAL_CSRF_COOKIE } from "../src/ops-feed.ts";
import type { PortalPerformed, PortalPreview } from "../src/ops-types/portal.ts";
import { captureErrors } from "./fakes.ts";
import {
  handlePortalPerform,
  handlePortalPreview,
  handlePortalSignOut,
  PORTAL_SIGN_OUT_PATH,
} from "../src/portal-actions.ts";
import {
  NOW,
  LATER,
  world,
  post,
  preview,
  perform,
  deps,
  wroteNothing,
  previewOk,
  issue,
  doPerform,
  tamper,
  auditRows,
} from "./portal-actions-fixtures.ts";

test("a co-owner's click is audited under her own verified email, never ADMIN_EMAIL", async () => {
  const w = world({ coOwners: " other@example.com , co@example.com " });
  const co = { session: "co@example.com" };
  const prev = await handlePortalPreview(
    await preview({ action: "revoke_agent", params: { name: "capsid-driver" } }, co),
    w.env,
    NOW,
  );
  assert.equal(prev.status, 200, await prev.clone().text());
  const { token } = (await prev.json()) as PortalPreview;
  const res = await handlePortalPerform(await perform({ token }, co), w.env, NOW, deps);
  assert.equal(res.status, 200, await res.clone().text());
  const rows = auditRows(w.d1);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row, / by access:co@example\.com$/, row);
    assert.doesNotMatch(row, /admin@example\.com/, row);
  }
  const click = w.d1.recorded.find((r) => r.params[1] === "portal-revoke_agent");
  assert.equal(click?.params[0], "access:co@example.com");
});

// A confirmation is used once: the nonce makes a second perform a refusal of its own.
test("PLANT: a confirmation is spent by its first perform, and a replay is refused with 409 and writes nothing", async () => {
  const w = world();
  const { token } = await issue(w);
  const first = await doPerform(w, token);
  assert.equal(first.status, 200, await first.clone().text());
  const before = w.d1.recorded.length;
  const second = await doPerform(w, token, {}, LATER(4 * 60_000));
  assert.equal(second.status, 409);
  assert.match(await second.text(), /already used/);
  assert.equal(w.d1.recorded.length, before, "a replayed confirmation wrote a row");
  assert.equal(auditRows(w.d1).filter((r) => r.startsWith("portal-revoke_agent")).length, 1);
});

test("PLANT: a token that is expired, edited, for another action or session, or malformed is refused, and writes nothing", async () => {
  type World = ReturnType<typeof world>;
  const withBody = async (w: World, body: object) =>
    handlePortalPerform(await perform(body), w.env, NOW, deps);
  const cases: Array<
    [string, (w: World, token: string) => Promise<[Response, World]>, number, RegExp]
  > = [
    [
      "expired",
      async (w, t) => [await doPerform(w, t, {}, LATER(5 * 60_000 + 1_000)), w],
      410,
      /expired: preview again/,
    ],
    [
      "params edited",
      async (w, t) => [
        await doPerform(
          w,
          tamper(t, (c) => ((c.params as Record<string, string>).name = "capsid-new-driver")),
        ),
        w,
      ],
      403,
      /does not verify/,
    ],
    [
      "action edited",
      async (w, t) => [
        await doPerform(
          w,
          tamper(t, (c) => (c.action = "activate_agent")),
        ),
        w,
      ],
      403,
      /does not verify/,
    ],
    [
      "another action beside it",
      async (w, t) => [await withBody(w, { token: t, action: "activate_agent" }), w],
      400,
      /only \{ token \}/,
    ],
    [
      "params in the body",
      async (w, t) => [await withBody(w, { token: t, params: { name: "x" } }), w],
      400,
      /only \{ token \}/,
    ],
    // ADMIN_EMAIL changed between preview and perform, and the new administrator signed in.
    [
      "another session",
      async (_w, t) => {
        const other = world({ adminEmail: "other@example.com" });
        return [
          await handlePortalPerform(
            await perform({ token: t }, { session: "other@example.com" }),
            other.env,
            NOW,
            deps,
          ),
          other,
        ];
      },
      403,
      /issued for another email/,
    ],
    ...["", "abc", "abc.def", `${"a".repeat(10)}.${"g".repeat(64)}`].map(
      (bad): [string, (w: World) => Promise<[Response, World]>, number, RegExp] => [
        `malformed '${bad.slice(0, 12)}'`,
        async (w) => [await doPerform(w, bad), w],
        403,
        /./,
      ],
    ),
  ];
  for (const [label, run, status, pattern] of cases) {
    const w = world();
    const { token } = await issue(w);
    const [res, checked] = await run(w, token);
    assert.equal(res.status, status, label);
    assert.match(await res.text(), pattern, label);
    wroteNothing(checked, label);
  }
});

test("a mutator refusal at perform is a 400 with its refusal, and no click row", async () => {
  const w = world();
  const { token } = await previewOk(w, "revoke_agent", { name: "capsid-driver" });
  w.d1.rows.agents[0].revoked_at = "2026-09-28 11:59:00";
  const res = await doPerform(w, token);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no live agent named 'capsid-driver'/);
  assert.deepEqual(auditRows(w.d1), []);
});

test("an action that happened but whose click row failed returns 200 with the warning, in the body and a header", async () => {
  const w = world();
  const { token } = await issue(w);
  const db = w.d1.db as unknown as {
    batch: (s: Array<{ params?: unknown[] }>) => Promise<unknown>;
  };
  const batch = db.batch.bind(db);
  db.batch = async (statements) => {
    if (statements.some((s) => s.params?.[1] === "portal-revoke_agent"))
      throw new Error("D1_ERROR: database is locked");
    return batch(statements);
  };
  const { result: res, errors } = await captureErrors(() => doPerform(w, token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as PortalPerformed;
  assert.match(
    body.warning ?? "",
    /revoke_agent completed, but the Portal audit row naming access:admin@example.com was not written/,
  );
  assert.match(res.headers.get("X-Capsid-Warning") ?? "", /revoke_agent completed/);
  assert.ok(w.d1.rows.agents[0].revoked_at, "the action itself did not happen");
  assert.equal(errors.length, 1);
});

const revokePreview = (site: string | null) =>
  preview({ action: "revoke_agent", params: { name: "capsid-driver" } }, { site });

test("PLANT: Sec-Fetch-Site cross-site and same-site are refused on both POSTs; same-origin, none and absent pass", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const w = world();
    const res = await handlePortalPreview(await revokePreview(site), w.env, NOW);
    assert.equal(res.status, 403, `preview served Sec-Fetch-Site: ${site}`);
    const { token } = await issue(w);
    const performed = await handlePortalPerform(
      await perform({ token }, { site }),
      w.env,
      NOW,
      deps,
    );
    assert.equal(performed.status, 403, `perform served Sec-Fetch-Site: ${site}`);
    wroteNothing(w, `Sec-Fetch-Site: ${site}`);
  }
  // "none" is a request the user started (site-runtime refuseCrossSite), which no other site can forge.
  for (const site of ["same-origin", "none", null]) {
    const w = world();
    const res = await handlePortalPreview(await revokePreview(site), w.env, NOW);
    assert.equal(res.status, 200, `preview refused Sec-Fetch-Site: ${site}`);
  }
});

test("a body over 64KB is refused with 413 before it is parsed, and one that is not a JSON object with 400", async () => {
  const big = JSON.stringify({ action: "revoke_agent", params: { name: "x".repeat(70_000) } });
  for (const [raw, status] of [
    [big, 413],
    ["not json", 400],
    ["[]", 400],
    ["null", 400],
  ] as const) {
    const res = await handlePortalPreview(await preview(null, { raw }), world().env, NOW);
    assert.equal(res.status, status, raw.slice(0, 20));
  }
});

// Node's Headers has getSetCookie; the Workers types this suite checks against do not.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

const signOut = () => post(PORTAL_SIGN_OUT_PATH, {});

test("sign out expires the session and CSRF cookies at Path=/portal, and ends a copy of that session, not the others, on the server", async () => {
  const w = world();
  const request = await signOut();
  const copy = request.clone();
  const res = await handlePortalSignOut(request, w.env, NOW);
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  const names = cookies.map((c) => c.split("=")[0]).sort();
  assert.deepEqual(
    names,
    ["__Secure-capsid_portal", `__Secure-${PORTAL_CSRF_COOKIE}`].sort(),
    cookies.join(" | "),
  );
  for (const c of cookies) {
    assert.match(c, /; Max-Age=0(;|$)/, `${c} does not expire the cookie`);
    assert.match(
      c,
      /; Path=\/portal(;|$)/,
      `${c} is not scoped to the Portal, so it would not clear the cookie the login set`,
    );
    assert.match(c, /; Secure; HttpOnly; SameSite=Lax/);
  }
  wroteNothing(w, "sign out");
  const again = await handlePortalSignOut(copy, w.env, NOW);
  assert.equal(again.status, 302, "a copy of the signed-out session was still admitted");
  const other = await handlePortalSignOut(await signOut(), w.env, NOW);
  assert.equal(other.status, 204, "signing out one session ended another");
});
