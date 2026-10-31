import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
// @ts-expect-error scripts/ is plain .mjs with no declarations, deliberately: it
// runs in the live CI job with no npm ci and no build step.
import { ACCESS_SAAS } from "../scripts/bindings.mjs";
// @ts-expect-error as above
import { PROBE_REDIRECT } from "../scripts/cimd-probe-lib.mjs";

// A local server that plays a healthy Worker for scripts/verify-live.mjs, and the runner
// that points the real script at it. Shared by test/verify-live-no-answer.test.ts and
// test/live-gate-mcp.test.ts.

export const SCRIPT = join(import.meta.dirname, "..", "scripts", "verify-live.mjs");
export const SHA = "4df127439ed3aa19aef8e350ab6311957b8f8611";

const BASE: Record<string, string> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};
export const NON_HTML = { ...BASE, "content-security-policy-report-only": "default-src 'none'" };
export const HTML = {
  ...BASE,
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=()",
  "content-security-policy": "default-src 'self'",
  "cross-origin-opener-policy-report-only": "same-origin",
};

// A Worker that passes every gate.
export function healthy(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { ...NON_HTML, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return json(200, { status: "ok", sha: SHA, dirty: false, store: { d1: "ok", fts: "ok" } });
  // CIMD, and tightened DCR that refuses the probe's unlisted redirect, and the probe
  // document served here, at the URL the script is pointed at through VERIFY_PROBE_CLIENT_ID.
  if (url.pathname === "/register") return json(400, { error: "invalid_redirect_uri", error_description: "not an allowed redirect URI" });
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(200, { client_id_metadata_document_supported: true, registration_endpoint: `http://${req.headers.host}/register` });
  }
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
    res.writeHead(200, { ...HTML, "set-cookie": "__Host-consent=c1; Path=/; HttpOnly" });
    return res.end(`<form method="post"><input type="hidden" name="handle" value="h1"></form>`);
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

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Serves `handler` except where `drop` says to destroy the socket instead of answering,
// which is what a reset connection looks like to fetch.
export async function run(handler: Handler, drop: (req: IncomingMessage, nth: number) => boolean, extraEnv: Record<string, string> = {}) {
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
      ...extraEnv,
    };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.PROBE_CLIENT_FILE;
    delete env.ASSERT_BACKUP_FRESH;
    if (!extraEnv.CAPSID_LIVE_PROBE_KEY) delete env.CAPSID_LIVE_PROBE_KEY;
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

export function breaking(change: (req: IncomingMessage, res: ServerResponse) => boolean): Handler {
  return (req, res) => {
    if (!change(req, res)) healthy(req, res);
  };
}
