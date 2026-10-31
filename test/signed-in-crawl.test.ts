import assert from "node:assert/strict";
import { test } from "node:test";
import { crawlApp, PORTAL_ORIGIN } from "../src/signed-in-crawl.ts";

// The crawl's verdicts on a fake app: a crawl that never got past the sign-in is "error", never a pass, and a JSON
// action that reads a text/plain or form body (R4) is an error, while a cross-origin load is a warning only.

const page = (html: string) => new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });

test("PLANT: a sign-in redirect is an error; an action that is not 415 to a form body fails R4; a cross-origin script warns", async () => {
  const redirected = await crawlApp({
    origin: PORTAL_ORIGIN,
    fetch: async () => new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } }),
    headers: {},
    pages: ["/"],
  });
  assert.equal(redirected.status, "error");
  assert.match(redirected.findings[0]?.detail ?? "", /did not reach the signed-in pages/);

  const methods: string[] = [];
  const result = await crawlApp({
    origin: PORTAL_ORIGIN,
    fetch: async (request) => {
      methods.push(`${request.method} ${request.headers.get("Content-Type") ?? ""}`.trim());
      if (request.method === "POST") return new Response("csrf", { status: request.headers.get("Content-Type") === "text/plain" ? 415 : 403 });
      return page('<script src="https://cdn.example.com/x.js"></script><script src="/assets/app.js"></script>');
    },
    headers: {},
    pages: ["/"],
    actions: ["/api/actions/preview"],
  });
  assert.equal(result.status, "fail");
  const r4 = result.findings.filter((f) => f.check === "R4");
  assert.equal(r4.length, 1);
  assert.match(r4[0]?.detail ?? "", /application\/x-www-form-urlencoded/);
  assert.ok(result.findings.some((f) => f.check === "I3" && f.severity === "warning" && f.detail.includes("https://cdn.example.com")));
  // The page, its first same-origin script, then the two probes: nothing else is sent.
  assert.deepEqual(methods, ["GET", "GET", "POST text/plain", "POST application/x-www-form-urlencoded"]);
});
