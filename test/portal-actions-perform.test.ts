import assert from "node:assert/strict";
import { test } from "node:test";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { PORTAL_CSRF_COOKIE } from "../src/ops-feed.ts";
import type { PortalPerformed, PortalPreview } from "../src/ops-types/portal.ts";
import { captureErrors, FEED } from "./fakes.ts";
import {
  handlePortalActivity,
  handlePortalApiNotFound,
  handlePortalNamespaces,
  handlePortalPerform,
  handlePortalPreview,
  handlePortalSignOut,
  PORTAL_ACTIVITY_PATH,
  PORTAL_CSRF_HEADER,
  PORTAL_NAMESPACES_PATH,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
  PORTAL_SIGN_OUT_PATH,
} from "../src/portal-actions.ts";
import { handlePortalClaims, PORTAL_CLAIMS_PATH } from "../src/portal-claims.ts";
import { handlePortalStale, PORTAL_STALE_PATH } from "../src/portal-stale.ts";
import { handlePortalLibrary, PORTAL_LIBRARY_PATH } from "../src/portal-library.ts";
import { handlePortalTrends, PORTAL_TRENDS_PATH } from "../src/portal-trends.ts";
import {
  handlePortalDigest,
  handlePortalPlan,
  PORTAL_DIGEST_PATH,
  PORTAL_PLAN_PATH,
} from "../src/portal-overnight.ts";
import { handlePortalMaintenance, PORTAL_MAINTENANCE_PATH } from "../src/portal-maintenance.ts";
import { handlePortalConvergence, PORTAL_CONVERGENCE_PATH } from "../src/portal-convergence.ts";
import {} from "node:path";
import {
  type Opts,
  SECRET,
  CSRF,
  NOW,
  EMAIL,
  ACTOR,
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
  EVERY_ACTION,
  auditRows,
} from "./portal-actions-fixtures.ts";

// Perform

// The action whose mutator writes KV and one audit row, and the revoke; the job
// transitions (close_shipped, supersede, park and unpark among them), the PR close, the approval, the site edits, the package edits,
// the site key, the project edits and the canon decisions are performed against real D1 in test-integration/portal-actions.test.ts.
for (const [action, params] of EVERY_ACTION.filter(
  ([a]) =>
    !a.endsWith("_job") &&
    a !== "close_shipped" &&
    a !== "pr_close" &&
    a !== "approve_pr" &&
    !a.startsWith("site_") &&
    !a.startsWith("package_") &&
    !a.startsWith("namespace_"),
)) {
  test(`${action} performed from its token writes the rows its preview listed, and returns the feed`, async () => {
    const w = world();
    const { token, audit } = await previewOk(w, action, params);
    const res = await doPerform(w, token);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as PortalPerformed;
    assert.equal(body.action, action);
    assert.equal(body.warning, null);
    assert.deepEqual(
      body.feed,
      { ...FEED, csrf: CSRF, user: { name: "admin", initials: "A" } },
      "the feed does not carry the session's csrf",
    );
    assert.deepEqual(
      auditRows(w.d1).sort(),
      [...audit].sort(),
      "the rows written are not the rows the preview listed",
    );
  });
}

test("a co-owner's click is audited under her own verified email, never ADMIN_EMAIL", async () => {
  const w = world({ coOwners: " other@example.com , co@example.com " });
  const co = { session: "co@example.com" };
  const prev = await handlePortalPreview(
    await preview(
      { action: "overnight", params: { value: "api", reason: "first supervised night" } },
      co,
    ),
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
  const click = w.d1.recorded.find((r) => r.params[1] === "portal-overnight");
  assert.equal(click?.params[0], "access:co@example.com");
});

test("a co-owner's session is refused when CO_OWNER_EMAILS is unset", async () => {
  const none = world();
  const refused = await handlePortalPreview(
    await preview(
      { action: "overnight", params: { value: "api", reason: "r" } },
      { session: "co@example.com" },
    ),
    none.env,
    NOW,
  );
  assert.equal(refused.status, 302, "an unadmitted session is sent to sign in");
  wroteNothing(none, "a co-owner with no CO_OWNER_EMAILS");
});

// A confirmation is used once the nonce makes a second perform a
// refusal of its own.
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
  assert.equal(auditRows(w.d1).filter((r) => r.startsWith("portal-overnight")).length, 1);
});

test("PLANT: an expired token is refused with 410 and nothing is performed", async () => {
  const w = world();
  const { token } = await issue(w);
  const res = await doPerform(w, token, {}, LATER(5 * 60_000 + 1_000));
  assert.equal(res.status, 410);
  assert.match(await res.text(), /expired: preview again/);
  wroteNothing(w, "an expired perform");
});

test("PLANT: a token whose params were edited is refused with 403", async () => {
  const w = world();
  const { token } = await issue(w);
  const edited = tamper(
    token,
    (c) => ((c.params as Record<string, string>).value = "subscription"),
  );
  const res = await handlePortalPerform(await perform({ token: edited }), w.env, NOW, deps);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /does not verify/);
  wroteNothing(w, "a tampered perform");
});

test("PLANT: a token for one action cannot perform another", async () => {
  const w = world();
  const { token } = await issue(w);
  // Named in the body beside the token: refused, and the token's action does not run.
  const named = await handlePortalPerform(
    await perform({ token, action: "reset_breaker" }),
    w.env,
    NOW,
    deps,
  );
  assert.equal(named.status, 400);
  // Written into the token itself: the signature no longer verifies.
  const edited = tamper(token, (c) => (c.action = "reset_breaker"));
  const signed = await handlePortalPerform(await perform({ token: edited }), w.env, NOW, deps);
  assert.equal(signed.status, 403);
  wroteNothing(w, "a cross-action perform");
});

test("PLANT: a perform body carrying params is refused, whatever the token", async () => {
  const w = world();
  const { token } = await issue(w);
  const res = await handlePortalPerform(
    await perform({ token, params: { value: "subscription", reason: "not what was previewed" } }),
    w.env,
    NOW,
    deps,
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /only \{ token \}/);
  wroteNothing(w, "a perform with params");
});

test("a token issued to another session is refused with 403", async () => {
  const w = world();
  const { token } = await issue(w);
  // ADMIN_EMAIL changed between the preview and the perform, and the new administrator
  // signed in: a valid session, a valid signature, the wrong person.
  const other = world({ adminEmail: "other@example.com" });
  const res = await handlePortalPerform(
    await perform({ token }, { session: "other@example.com" }),
    other.env,
    NOW,
    deps,
  );
  assert.equal(res.status, 403);
  assert.match(await res.text(), /issued for another email/);
  wroteNothing(other, "another session's perform");
});

test("a malformed token is refused with 403", async () => {
  for (const token of ["", "abc", "abc.def", `${"a".repeat(10)}.${"g".repeat(64)}`]) {
    const w = world();
    const res = await doPerform(w, token);
    assert.equal(res.status, 403, `token '${token}'`);
    wroteNothing(w, "a malformed perform");
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
    if (statements.some((s) => s.params?.[1] === "portal-overnight"))
      throw new Error("D1_ERROR: database is locked");
    return batch(statements);
  };
  const { result: res, errors } = await captureErrors(() => doPerform(w, token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as PortalPerformed;
  assert.match(
    body.warning ?? "",
    /overnight completed, but the Portal audit row naming access:admin@example.com was not written/,
  );
  assert.match(res.headers.get("X-Capsid-Warning") ?? "", /overnight completed/);
  assert.equal(w.kv.store.get("overnight:mode"), "api", "the action itself did not happen");
  assert.equal(errors.length, 1);
});

// Fetch metadata, the body cap, the JSON

const overnightPreview = (site: string | null) =>
  preview(
    { action: "overnight", params: { value: "api", reason: "first supervised night" } },
    { site },
  );

test("PLANT: Sec-Fetch-Site cross-site and same-site are refused on both POSTs; same-origin, none and absent pass", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const w = world();
    const res = await handlePortalPreview(await overnightPreview(site), w.env, NOW);
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
    const res = await handlePortalPreview(await overnightPreview(site), w.env, NOW);
    assert.equal(res.status, 200, `preview refused Sec-Fetch-Site: ${site}`);
  }
});

test("a body over 64KB is refused with 413 before it is parsed", async () => {
  const w = world();
  const res = await handlePortalPreview(
    await preview(null, {
      raw: JSON.stringify({ action: "overnight", params: { value: "x".repeat(70_000) } }),
    }),
    w.env,
    NOW,
  );
  assert.equal(res.status, 413);
});

test("a body that is not a JSON object is refused with 400", async () => {
  for (const raw of ["not json", "[]", "null"]) {
    const res = await handlePortalPreview(await preview(null, { raw }), world().env, NOW);
    assert.equal(res.status, 400, raw);
  }
});

// The gate, on all four routes

const ROUTES = [
  [PORTAL_PREVIEW_PATH, "POST", (r: Request, e: never) => handlePortalPreview(r, e, NOW)],
  [PORTAL_PERFORM_PATH, "POST", (r: Request, e: never) => handlePortalPerform(r, e, NOW, deps)],
  [PORTAL_NAMESPACES_PATH, "GET", (r: Request, e: never) => handlePortalNamespaces(r, e, NOW)],
  [PORTAL_ACTIVITY_PATH, "GET", (r: Request, e: never) => handlePortalActivity(r, e, NOW)],
  [PORTAL_CLAIMS_PATH, "GET", (r: Request, e: never) => handlePortalClaims(r, e, NOW)],
  [PORTAL_STALE_PATH, "GET", (r: Request, e: never) => handlePortalStale(r, e, NOW)],
  [PORTAL_LIBRARY_PATH, "GET", (r: Request, e: never) => handlePortalLibrary(r, e, NOW)],
  [PORTAL_TRENDS_PATH, "GET", (r: Request, e: never) => handlePortalTrends(r, e, NOW)],
  [PORTAL_PLAN_PATH, "GET", (r: Request, e: never) => handlePortalPlan(r, e, NOW)],
  [PORTAL_DIGEST_PATH, "GET", (r: Request, e: never) => handlePortalDigest(r, e, NOW)],
  [PORTAL_MAINTENANCE_PATH, "GET", (r: Request, e: never) => handlePortalMaintenance(r, e, NOW)],
  [PORTAL_CONVERGENCE_PATH, "GET", (r: Request, e: never) => handlePortalConvergence(r, e, NOW)],
  [PORTAL_SIGN_OUT_PATH, "POST", (r: Request, e: never) => handlePortalSignOut(r, e, NOW)],
  ["/portal/api/not-a-route", "GET", (r: Request, e: never) => handlePortalApiNotFound(r, e, NOW)],
] as const;

test("every route refuses a bearer with 403 and sends an anonymous caller to sign in", async () => {
  for (const [path, method, handler] of ROUTES) {
    const session = (await portalSessionCookie({ email: EMAIL }, SECRET, NOW)).split(";")[0];
    const headers = {
      Cookie: `${session}; __Secure-${PORTAL_CSRF_COOKIE}=${CSRF}`,
      [PORTAL_CSRF_HEADER]: CSRF,
      "Sec-Fetch-Site": "same-origin",
    };
    const body =
      method === "POST"
        ? JSON.stringify({
            action: "overnight",
            params: { value: "api", reason: "first supervised night" },
          })
        : undefined;
    // A bearer beside a valid session and CSRF pair is still refused: the gate reads it first.
    const bearer = await handler(
      new Request(`https://capsid.example${path}`, {
        method,
        headers: { ...headers, Authorization: "Bearer capsid_x" },
        body,
      }),
      world().env,
    );
    assert.equal(bearer.status, 403, `${path} served a bearer`);
    const anonymous = await handler(
      new Request(`https://capsid.example${path}`, {
        method,
        headers: { [PORTAL_CSRF_HEADER]: CSRF },
        body,
      }),
      world().env,
    );
    assert.equal(anonymous.status, 302, `${path} did not send an anonymous caller to sign in`);
    assert.match(anonymous.headers.get("Location") ?? "", /sample\.cloudflareaccess\.com/);
  }
});

// Sign out

// Node's Headers has getSetCookie; the Workers types this suite checks against do not.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

async function signOut(opts: Opts = {}): Promise<Request> {
  return post(PORTAL_SIGN_OUT_PATH, {}, opts);
}

test("sign out expires the session and CSRF cookies at Path=/portal, and ends a copy of that session, not the others, on the server", async () => {
  const w = world();
  const request = await signOut();
  const copy = request.clone();
  const res = await handlePortalSignOut(request, w.env, NOW);
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  // Each under its __Secure- name.
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
  // The same session cookie, sent again from anywhere, is a sign-in redirect now.
  const again = await handlePortalSignOut(copy, w.env, NOW);
  assert.equal(again.status, 302, "a copy of the signed-out session was still admitted");
  // A session from another sign-in of the same person goes on.
  const other = await handlePortalSignOut(await signOut(), w.env, NOW);
  assert.equal(other.status, 204, "signing out one session ended another");
});

for (const [label, opts] of [
  ["with no CSRF header", { csrfHeader: null }],
  [
    "when the CSRF header does not match the cookie",
    { csrfHeader: "ffffffff-2222-4333-8444-555555555555" },
  ],
  ["from another site", { site: "cross-site" }],
] as const) {
  test(`PLANT: sign out REFUSES ${label}, and clears nothing`, async () => {
    const w = world();
    const res = await handlePortalSignOut(await signOut(opts), w.env, NOW);
    assert.equal(res.status, 403, `sign out was served ${label}`);
    assert.deepEqual(setCookies(res), [], `sign out cleared a cookie ${label}`);
    wroteNothing(w, `sign out ${label}`);
  });
}

// The overnight run's switch (src/overnight.ts)

test("PLANT: performing the subscription choice stores the mode and the decision record with the date, who set it and why; leaving it deletes the record", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", {
    value: "subscription",
    reason: "first supervised night",
  });
  const done = await doPerform(w, token);
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(await w.kv.kv.get("overnight:mode"), "subscription");
  const decision = JSON.parse((await w.kv.kv.get("overnight:decision")) ?? "null");
  assert.equal(decision.decided_by, "Dustin Edwards");
  assert.equal(decision.decided_on, "2026-10-04");
  assert.equal(decision.set_by, ACTOR);
  assert.equal(decision.reason, "first supervised night");
  // The audit rows carry the same record, so the choice is visible in Activity.
  const mutator = w.d1.recorded.find((r) => r.params[1] === "overnight-set");
  assert.ok(mutator, "no overnight-set audit row");
  assert.match(String(mutator.params[4]), /Dustin Edwards/);

  const off = await previewOk(w, "overnight", { value: "off", reason: "done for now" });
  const turned = await handlePortalPerform(await perform({ token: off.token }), w.env, NOW, deps);
  assert.equal(turned.status, 200, await turned.clone().text());
  assert.equal(await w.kv.kv.get("overnight:mode"), "off");
  assert.equal(await w.kv.kv.get("overnight:decision"), null);
});
