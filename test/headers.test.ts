import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSecurityHeaders, failures } from "@dustinedwards/site-runtime/check";
import { STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime/headers";
import {
  CAPSID_STANDARD_HEADERS,
  classifySurface,
  COOP_REPORT_ONLY,
  CSP_REPORT_ONLY_NON_HTML,
  HSTS,
  PERMISSIONS_POLICY,
  REPORT_PATH,
  securityHeadersFor,
  withSecurityHeaders,
} from "../src/headers.ts";

// The offline half of the security header checks; the live half is in
// scripts/verify-live.mjs. These assert the classes, not a list of paths, because a
// path list would still pass when a new response exit appears.

test("classifySurface maps every content type capsid actually emits", () => {
  assert.equal(classifySurface("text/html;charset=utf-8"), "html");
  assert.equal(classifySurface("application/json"), "json");
  // The provider and the MCP handler both emit +json suffix types.
  assert.equal(classifySurface("application/problem+json"), "json");
  assert.equal(classifySurface("application/reports+json"), "json");
  assert.equal(classifySurface("text/plain;charset=UTF-8"), "other");
  assert.equal(classifySurface("text/event-stream"), "other");
  // The provider's /mcp 401 carries no Content-Type. It must still be classified.
  assert.equal(classifySurface(null), "other");
});

test("case does not change the class", () => {
  assert.equal(classifySurface("TEXT/HTML"), "html");
  assert.equal(classifySurface("Application/JSON"), "json");
});

test("HTML carries every header of the package's standard set, and COOP only as Report-Only", () => {
  const h = securityHeadersFor("html");
  for (const [name, value] of Object.entries(CAPSID_STANDARD_HEADERS)) assert.equal(h[name], value, `html lost ${name}`);
  assert.equal(h["Strict-Transport-Security"], HSTS);
  assert.equal(h["Permissions-Policy"], PERMISSIONS_POLICY);
  // The one header Capsid does not take from the package, kept on trial, not enforced.
  assert.equal(h["Cross-Origin-Opener-Policy-Report-Only"], COOP_REPORT_ONLY);
  assert.equal(h["Cross-Origin-Opener-Policy"], undefined);
});

test("the set differs from the package's standard by exactly one header, derived both ways", () => {
  const missing = Object.keys(STANDARD_SECURITY_HEADERS).filter((k) => !(k in CAPSID_STANDARD_HEADERS));
  const extra = Object.keys(CAPSID_STANDARD_HEADERS).filter((k) => !(k in STANDARD_SECURITY_HEADERS));
  assert.deepEqual(missing, ["Cross-Origin-Opener-Policy"]);
  assert.deepEqual(extra, []);
  assert.ok(Object.keys(STANDARD_SECURITY_HEADERS).length > 5, "the package's set was read, not an empty one");
});

test("every class passes the package's own check against the set Capsid declared, with a count of what it read", () => {
  for (const cls of ["html", "json", "other"] as const) {
    const results = checkSecurityHeaders(new Headers(withSecurityHeaders(new Response("x", { headers: { "Content-Type": cls === "html" ? "text/html" : cls === "json" ? "application/json" : "text/plain" } })).headers), {
      standard: CAPSID_STANDARD_HEADERS,
      csp: false,
    });
    assert.equal(results.length, Object.keys(CAPSID_STANDARD_HEADERS).length, `${cls}: the check read a different number of headers than the set holds`);
    assert.deepEqual(failures(results), [], `${cls} fails the package check`);
  }
});

test("PLANT: a response that lacks a header of the set fails the check, as a header dropped from /health would", () => {
  const health = withSecurityHeaders(Response.json({ status: "ok" }));
  const headers = new Headers(health.headers);
  headers.delete("X-Frame-Options");
  const failed = failures(checkSecurityHeaders(headers, { standard: CAPSID_STANDARD_HEADERS, csp: false }));
  assert.deepEqual(failed.map((r) => r.name), ["X-Frame-Options is present"]);
});

test("JSON carries nosniff and HSTS, and no enforced CSP", () => {
  const h = securityHeadersFor("json");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Strict-Transport-Security"], HSTS);
  assert.equal(h["Content-Security-Policy-Report-Only"], CSP_REPORT_ONLY_NON_HTML);
  assert.equal(h["Content-Security-Policy"], undefined);
});

test("every class gets HSTS and nosniff, with no exception", () => {
  for (const cls of ["html", "json", "other"] as const) {
    const h = securityHeadersFor(cls);
    assert.equal(h["Strict-Transport-Security"], HSTS, `${cls} lost HSTS`);
    assert.equal(h["X-Content-Type-Options"], "nosniff", `${cls} lost nosniff`);
  }
});

// If a change promotes either trial policy to enforced, this fails by name.
test("NOTHING is enforced that is meant to be Report-Only", () => {
  for (const cls of ["html", "json", "other"] as const) {
    const h = securityHeadersFor(cls);
    assert.equal(h["Cross-Origin-Opener-Policy"], undefined, `${cls} enforces COOP without a ruling`);
    // The consent dialog sets its own enforced CSP in routes.ts. This layer must
    // never add an enforced CSP of its own.
    assert.equal(h["Content-Security-Policy"], undefined, `${cls} enforces a CSP from the header layer`);
  }
});

test("the report-only policies point at the report sink", () => {
  assert.match(CSP_REPORT_ONLY_NON_HTML, new RegExp(`report-uri ${REPORT_PATH}`));
  assert.match(CSP_REPORT_ONLY_NON_HTML, /report-to csp/);
  for (const cls of ["json", "other"] as const) {
    assert.equal(securityHeadersFor(cls)["Reporting-Endpoints"], `csp="${REPORT_PATH}"`);
  }
});

test("form-action appears in no policy this layer emits", () => {
  // form-action breaks the OAuth redirect chain. It must not appear anywhere,
  // including in a Report-Only policy that could later be promoted.
  for (const cls of ["html", "json", "other"] as const) {
    for (const value of Object.values(securityHeadersFor(cls))) {
      assert.doesNotMatch(value, /form-action/, `${cls} names form-action`);
    }
  }
});

test("withSecurityHeaders preserves headers that are already set", () => {
  // The consent dialog's own CSP, nosniff, Referrer-Policy and X-Frame-Options
  // must survive untouched.
  const consentCsp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
  const original = new Response("<!doctype html>", {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy": consentCsp,
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.headers.get("Content-Security-Policy"), consentCsp);
  assert.equal(out.headers.get("X-Frame-Options"), "DENY");
  // and the missing three are added
  assert.equal(out.headers.get("Strict-Transport-Security"), HSTS);
  assert.equal(out.headers.get("Permissions-Policy"), PERMISSIONS_POLICY);
  assert.equal(out.headers.get("Cross-Origin-Opener-Policy-Report-Only"), COOP_REPORT_ONLY);
});

test("withSecurityHeaders does not overwrite a deliberately different value", () => {
  // Every header here IS in the html set, and every value differs from the
  // default. That combination is the only one that can detect a preserve bug: a
  // value equal to the default passes against an "overwrite everything" bug.
  const original = new Response("<!doctype html>", {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Referrer-Policy": "origin-when-cross-origin",
      "X-Frame-Options": "SAMEORIGIN",
      "Permissions-Policy": "camera=(self)",
      "Strict-Transport-Security": "max-age=60",
      "X-Content-Type-Options": "nosniff-but-different",
    },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.headers.get("Referrer-Policy"), "origin-when-cross-origin");
  assert.equal(out.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(out.headers.get("Permissions-Policy"), "camera=(self)");
  assert.equal(out.headers.get("Strict-Transport-Security"), "max-age=60");
  assert.equal(out.headers.get("X-Content-Type-Options"), "nosniff-but-different");
});

test("withSecurityHeaders preserves status, statusText and body", async () => {
  const original = new Response("not found", {
    status: 404,
    statusText: "Not Found",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.status, 404);
  assert.equal(out.statusText, "Not Found");
  assert.equal(await out.text(), "not found");
  assert.equal(out.headers.get("X-Content-Type-Options"), "nosniff");
});

test("a bodyless 302 survives the rebuild", () => {
  // startGithubFlow and handleCallback both return 302 with a null body, and a
  // Response constructed with a body on a 3xx would throw.
  const original = new Response(null, { status: 302, headers: { Location: "https://github.com/login/oauth/authorize" } });
  const out = withSecurityHeaders(original);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("Location"), "https://github.com/login/oauth/authorize");
  assert.equal(out.headers.get("Strict-Transport-Security"), HSTS);
});

test("HSTS does not claim preload", () => {
  // preload is a submission to a browser-vendor list and is effectively
  // irreversible.
  assert.doesNotMatch(HSTS, /preload/);
  // OWASP's value, two years, taken from the package; never shorter than the one year Capsid sent before.
  assert.ok(Number(/max-age=(\d+)/.exec(HSTS)?.[1]) >= 31536000, `HSTS lasts less than a year: ${HSTS}`);
});
