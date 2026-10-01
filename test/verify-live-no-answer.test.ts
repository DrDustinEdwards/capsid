import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { ACCESS_SAAS } from "../scripts/bindings.mjs";
// @ts-expect-error as above
import { PROBE_REDIRECT } from "../scripts/cimd-probe-lib.mjs";

// A gate that got no answer has not refused the deploy. scripts/verify-live.mjs
// retries a thrown fetch, records a gate whose requests never got an answer as
// could-not-run, and exits 3 rather than 1 when no gate refused. ci.yml rolls back
// on exit 1 only, so a connection reset must not roll back a good deploy.
//
// These run the real script against a local server that plays a healthy Worker, and
// can drop the connection instead of answering.

const SCRIPT = join(import.meta.dirname, "..", "scripts", "verify-live.mjs");
const SHA = "4df127439ed3aa19aef8e350ab6311957b8f8611";

const BASE: Record<string, string> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};
const NON_HTML = { ...BASE, "content-security-policy-report-only": "default-src 'none'" };
const HTML = {
  ...BASE,
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=()",
  "content-security-policy": "default-src 'self'",
  "cross-origin-opener-policy-report-only": "same-origin",
};

// A Worker that passes every gate.
function healthy(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { ...NON_HTML, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return json(200, { status: "ok", sha: SHA, dirty: false, store: { d1: "ok", fts: "ok" } });
  // CIMD only: no registration, and the probe document served here, at the URL the
  // script is pointed at through VERIFY_PROBE_CLIENT_ID.
  if (url.pathname === "/register") return json(404, { error: "not found" });
  if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { client_id_metadata_document_supported: true });
  if (url.pathname === "/probe-client.json") {
    return json(200, { client_id: `http://${req.headers.host}/probe-client.json`, client_name: "probe", redirect_uris: [PROBE_REDIRECT], token_endpoint_auth_method: "none" });
  }
  if (url.pathname === "/authorize" && req.method === "POST") {
    // The Access sign-in, as src/access-login.ts builds it, for this stub's own origin.
    const signIn = new URL(`${ACCESS_SAAS.teamDomain}/cdn-cgi/access/sso/oidc/${ACCESS_SAAS.clientId}/authorization`);
    for (const [k, v] of Object.entries({ client_id: ACCESS_SAAS.clientId, redirect_uri: `http://${req.headers.host}/callback`, response_type: "code", scope: "openid email profile", state: "s", nonce: "n", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" })) signIn.searchParams.set(k, v);
    res.writeHead(302, { ...NON_HTML, location: signIn.href });
    return res.end();
  }
  if (url.pathname === "/authorize" && url.searchParams.get("client_id")) {
    res.writeHead(200, { ...HTML, "set-cookie": "capsid_csrf=c1; Path=/; HttpOnly" });
    return res.end(`<form method="post" action="/authorize"><input name="csrf" value="c1"><input name="req" value="r1"></form>`);
  }
  if (url.pathname.startsWith("/.well-known/")) return json(200, {});
  // The Portal's own host, played under /portal-host (PORTAL_ORIGIN below): with no
  // session its root and its /mcp send the caller to the Access sign-in (gate 7).
  if (url.pathname === "/portal-host/" || url.pathname === "/portal-host/mcp") {
    res.writeHead(302, { ...NON_HTML, location: "https://sample.cloudflareaccess.com/cdn-cgi/access/login/portal" });
    return res.end();
  }
  // The MCP host serves no Portal (src/mcp-host.ts): the plain 404.
  if (url.pathname === "/portal/") {
    res.writeHead(404, NON_HTML);
    return res.end("not found");
  }
  if (url.pathname === "/csp-report") {
    res.writeHead(204, NON_HTML);
    return res.end();
  }
  const status = url.pathname === "/nope" || url.pathname.startsWith("/console") ? 404 : url.pathname.endsWith("mcp") || url.pathname === "/ops/backup" ? 401 : 400;
  return json(status, { error: "x" });
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Serves `handler` except where `drop` says to destroy the socket instead of answering,
// which is what a reset connection looks like to fetch.
async function run(handler: Handler, drop: (req: IncomingMessage, nth: number) => boolean) {
  const seen = new Map<string, number>();
  const server = createServer((req, res) => {
    const key = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    if (drop(req, nth)) {
      req.socket.destroy();
      return;
    }
    // No keep-alive: an idle pooled socket open when the child exits trips a libuv
    // assertion on Windows (exit 3221226505), which is noise here.
    res.setHeader("connection", "close");
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPECT_SHA: SHA,
      VERIFY_POLL_ATTEMPTS: "2",
      VERIFY_POLL_INTERVAL_MS: "5",
      VERIFY_FETCH_TRIES: "2",
      VERIFY_PROBE_CLIENT_ID: `http://127.0.0.1:${port}/probe-client.json`,
      // Gate 7 checks the Portal's own host; this stub plays it, so no run reaches the
      // real portal.dustinedwards.info.
      PORTAL_ORIGIN: `http://127.0.0.1:${port}/portal-host`,
    };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.PROBE_CLIENT_FILE;
    delete env.ASSERT_BACKUP_FRESH;
    const child = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${port}`], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    return { code, out };
  } finally {
    server.close();
  }
}

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
  assert.match(out, /NORUN {2}2 CIMD only, no registration/);
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
function breaking(change: (req: IncomingMessage, res: ServerResponse) => boolean): Handler {
  return (req, res) => {
    if (!change(req, res)) healthy(req, res);
  };
}

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

test("an enforced COOP or a non-html CSP no longer fails gate 6: those arms pinned a policy choice", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/nope") return false;
      res.writeHead(404, { ...NON_HTML, "content-security-policy": "default-src 'none'", "cross-origin-opener-policy": "same-origin" });
      res.end();
      return true;
    }),
    () => false
  );
  assert.equal(code, 0, out);
});

// Gate 2 since registration was removed: the script wiring, beside the decisions in
// test/cimd-probe.test.ts.
test("gate 2 refuses a Worker that still registers clients", async () => {
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
  assert.match(out, /FAIL {2}2 CIMD only, no registration\n.*answered 201; DCR is meant to be off/);
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
  assert.match(out, /FAIL {2}2 CIMD only, no registration\n.*not its own URL/);
  assert.match(out, /FAIL {2}3 consent form renders\n.*skipped: no probe client from gate 2/);
});

test("a probe document GitHub does not serve is could-not-run, not a refusal", async () => {
  const { code, out } = await run(
    breaking((req, res) => {
      if (req.url !== "/probe-client.json") return false;
      res.writeHead(404, NON_HTML);
      res.end();
      return true;
    }),
    () => false
  );
  assert.equal(code, 3, out);
  assert.match(out, /NORUN {2}2 CIMD only, no registration\n.*answered 404/);
  assert.match(out, /NORUN {2}3 consent form renders/);
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
