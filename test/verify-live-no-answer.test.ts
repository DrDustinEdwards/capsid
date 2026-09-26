import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

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
  if (url.pathname === "/register" && req.method === "POST") return json(201, { client_id: "probe-client" });
  if (url.pathname === "/authorize" && req.method === "POST") {
    res.writeHead(302, { ...NON_HTML, location: "https://github.com/login/oauth/authorize?client_id=x" });
    return res.end();
  }
  if (url.pathname === "/authorize" && url.searchParams.get("client_id")) {
    res.writeHead(200, { ...HTML, "set-cookie": "capsid_csrf=c1; Path=/; HttpOnly" });
    return res.end(`<form method="post" action="/authorize"><input name="csrf" value="c1"><input name="req" value="r1"></form>`);
  }
  if (url.pathname.startsWith("/.well-known/")) return json(200, {});
  if (url.pathname === "/csp-report") {
    res.writeHead(204, NON_HTML);
    return res.end();
  }
  const status = url.pathname === "/nope" ? 404 : url.pathname.endsWith("mcp") || url.pathname === "/ops/backup" ? 401 : 400;
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
  assert.match(out, /NORUN {2}2 register/);
  // The gates that depend on a client id inherit could-not-run rather than failing.
  assert.match(out, /NORUN {2}3 consent form renders/);
  assert.doesNotMatch(out, /FAIL {2}/);
});

test("one single-shot gate that never gets an answer makes the run exit 3", async () => {
  const { code, out } = await run(healthy, (req) => req.method === "POST" && req.url === "/authorize");
  assert.equal(code, 3, out);
  assert.match(out, /NORUN {2}5 approve redirects to GitHub/);
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
  assert.match(out, /NORUN {2}5 approve redirects to GitHub/);
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
