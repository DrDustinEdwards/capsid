import assert from "node:assert/strict";
import { test } from "node:test";
import { breaking, type Handler, healthy, HTML, NON_HTML, run, SHA } from "./verify-live-stub.ts";

// A gate that got no answer has not refused the deploy. scripts/verify-live.mjs
// retries a thrown fetch, records a gate whose requests never got an answer as
// could-not-run, and exits 3 rather than 1 when no gate refused. ci.yml rolls back
// on exit 1 only, so a connection reset must not roll back a good deploy.
//
// These run the real script against a local server that plays a healthy Worker
// (./verify-live-stub.ts), and can drop the connection instead of answering.

test("the fake Worker passes every gate, so the cases below measure the drops alone", async () => {
  const { code, out } = await run(healthy, () => false);
  assert.equal(code, 0, out);
});

test("a connection reset on the first try of every request is retried and the run passes", async () => {
  // One reset per request. Without the retry the first reset would exit 1, and exit 1
  // rolls back.
  const { code, out } = await run(healthy, (_req, nth) => nth === 1);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /FAIL|NORUN/);
});

test("a server that never answers is could-not-run (exit 3), not a refusal (exit 1)", async () => {
  const { code, out } = await run(healthy, () => true);
  assert.equal(code, 3, out);
  assert.match(out, /NORUN {2}1 health \+ provenance/);
  assert.match(out, /NORUN {2}2 CIMD, DCR allowlisted/);
  // The gates that depend on a client id inherit could-not-run rather than failing.
  assert.match(out, /NORUN {2}3 consent form renders/);
  assert.doesNotMatch(out, /FAIL {2}/);
});

test("one single-shot gate that never gets an answer makes the run exit 3", async () => {
  const { code, out } = await run(healthy, (req) => req.method === "POST" && req.url === "/authorize");
  assert.equal(code, 3, out);
  assert.match(out, /NORUN {2}5 approve redirects to Access/);
});

test("a server that answers with errors is still a refusal: exit 1", async () => {
  // An answer decides, and a 503 is an answer.
  const broken: Handler = (_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("down");
  };
  const { code, out } = await run(broken, () => false);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}1 health \+ provenance/);
});

test("a refusal outranks a gate that could not run: exit 1", async () => {
  // /health reports the wrong sha (a refusal) while the approve POST never answers.
  const wrongSha: Handler = (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { ...NON_HTML, "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", sha: "0".repeat(40), store: { d1: "ok", fts: "ok" } }));
    }
    healthy(req, res);
  };
  const { code, out } = await run(wrongSha, (req) => req.method === "POST" && req.url === "/authorize");
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}1 health \+ provenance/);
  assert.match(out, /NORUN {2}5 approve redirects to Access/);
});

// The folded gates: gate 1 carries the store check, and gate 6 carries the no-store
// check and the report sink. Each case breaks one of those checks.

test("gate 1 refuses a Worker whose FTS index is broken (was gate 1b)", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/health") return false;
      res.writeHead(200, { ...NON_HTML, "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sha: SHA, store: { d1: "ok", fts: "empty" } }));
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}1 health \+ provenance\n.*d1=ok fts=empty/);
});

test("gate 6 refuses a consent page without no-store (was gate 4b)", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.method !== "GET" || !req.url?.startsWith("/authorize?")) return false;
      res.writeHead(200, { ...HTML, "cache-control": "public, max-age=60", "set-cookie": "capsid_csrf=c1; Path=/" });
      res.end(`<form method="post" action="/authorize"><input name="csrf" value="c1"><input name="req" value="r1"></form>`);
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}6 security headers per class\n.*\/authorize consent: cache-control public, max-age=60, expected no-store/);
});

test("gate 6 refuses a report sink that does not answer 204 (was gate 7)", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/csp-report") return false;
      res.writeHead(500, NON_HTML);
      res.end();
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}6 security headers per class\n.*\/csp-report: status 500, expected 204/);
});

// Gate 2 with tightened DCR: the script wiring, beside the decisions in
// test/cimd-probe.test.ts.
test("gate 2 refuses a Worker that registers an unlisted redirect", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/register") return false;
      res.writeHead(201, { ...NON_HTML, "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: "registered" }));
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}2 CIMD, DCR allowlisted\n.*answered 201 for an unlisted redirect; the DCR allowlist is open/);
});

test("gate 2 refuses a probe document that is not its own URL's, and gates 3 to 5 do not run on it", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/probe-client.json") return false;
      res.writeHead(200, { ...NON_HTML, "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: "https://example.com/elsewhere.json", client_name: "probe", redirect_uris: ["https://example.com/verify-live-callback"], token_endpoint_auth_method: "none" }));
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}2 CIMD, DCR allowlisted\n.*not its own URL/);
  assert.match(out, /FAIL {2}3 consent form renders\n.*skipped: no probe client from gate 2/);
});

test("a probe document the Worker does not serve is a fail of this deploy", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/probe-client.json") return false;
      res.writeHead(404, NON_HTML);
      res.end();
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}2 CIMD, DCR allowlisted\n.*answered 404/);
  assert.match(out, /FAIL {2}3 consent form renders\n.*skipped: no probe client from gate 2/);
});

test("gate 6 refuses the Portal answering on the MCP host", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/portal/") return false;
      res.writeHead(302, { ...NON_HTML, location: "https://sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/x/authorization" });
      res.end();
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}6 security headers per class\n.*\/portal\/ not on this host: status 302, expected 404/);
});

test("gate 6 refuses an old /console address that answers anything but 404", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/console/app/") return false;
      res.writeHead(302, { ...NON_HTML, location: "/portal/" });
      res.end();
      return true;
    }),
    () => false
  );
  assert.equal(code, 1, out);
  assert.match(out, /FAIL {2}6 security headers per class\n.*\/console\/app\/ gone: status 302, expected 404/);
});
