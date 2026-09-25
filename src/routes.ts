import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { APPROVAL_MAX_AGE_SECONDS, approvalTag } from "./approval";
import { getCookie, hmacHex, timingSafeEqual } from "./auth";
import { resolveAgent } from "./agents";
import { runBackup } from "./backup";
import { routeRefusal } from "./scope";
import { b64urlDecode, b64urlEncode } from "./encoding";
import { CONSENT_DIALOG_HEADERS, REPORT_PATH, REPORT_PREFIX } from "./headers";
import { callerIp, checkRate, CSP_REPORT_LIMIT, rateLimitedResponse } from "./rate-limit";
import type { Env } from "./env";
import { buildServer } from "./server";
import { ingestScore } from "./improve-run";
import {
  BACKUP_CREDENTIAL_PATH,
  claimJti,
  CREDENTIAL_PATH,
  MAX_REPORT_BYTES,
  mintBackupCredential,
  mintHoldoutCredential,
  parseBackupCredentialRequest,
  parseCredentialRequest,
  parseScoreReport,
  readBoundedText,
  SCORE_PATH,
  verifyBackupCredentialRequest,
  verifySignedReport,
} from "./improve-scorer";
import { handleHealth } from "./health";
import { escapeHtml } from "./html";
import {
  CONSOLE_CALLBACK_PATH,
  CONSOLE_JSON_PATH,
  CONSOLE_PATH,
  handleConsole,
  handleConsoleJson,
} from "./console";
import { handleConsoleAction } from "./console-actions";
import { handleConsoleCallback } from "./console-auth";
import { clearStateCookie, completeGithubLogin, type GithubLoginFlow, startGithubLogin, STATE_TTL_SECONDS } from "./github-login";

const APPROVAL_COOKIE = "capsid_approved";
const CSRF_COOKIE = "capsid_csrf";

// The MCP authorization flow's half of the GitHub login (src/github-login.ts). The
// state stored against the token is the JSON AuthRequest.
const MCP_LOGIN: GithubLoginFlow = {
  callbackPath: "/callback",
  stateCookie: "capsid_state",
  cookiePath: "/callback",
  kvPrefix: "capsid:oauth-state:",
  restartHint: "Restart from your MCP client.",
};

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

// The approval cookie carries entries from src/approval.ts: a client id bound to a
// digest of its redirect set, signed with COOKIE_ENCRYPTION_KEY, kept 30 days.
// Cookies cap near 4KB; an entry is about 36 bytes of JSON, and the 30 day expiry
// bounds the growth.
async function approvedClients(request: Request, secret: string): Promise<string[]> {
  const raw = getCookie(request, APPROVAL_COOKIE);
  if (!raw) return [];
  const dot = raw.indexOf(".");
  if (dot === -1) return [];
  const sig = raw.slice(0, dot);
  const payload = raw.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmacHex(secret, payload))) return [];
  try {
    const parsed = JSON.parse(b64urlDecode(payload));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function approvalCookie(tags: string[], secret: string): Promise<string> {
  const payload = b64urlEncode(JSON.stringify(tags));
  const sig = await hmacHex(secret, payload);
  return `${APPROVAL_COOKIE}=${sig}.${payload}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=${APPROVAL_MAX_AGE_SECONDS}`;
}

function renderApprovalDialog(oauthReq: AuthRequest, clientName: string, csrf: string, registeredUris: string[] | undefined): Response {
  const name = escapeHtml(clientName);
  const redirect = escapeHtml(oauthReq.redirectUri);
  const req = b64urlEncode(JSON.stringify(oauthReq));
  // Every registered redirect URI is shown, not just the requested one. A dynamically
  // registered client may hold several and the approval covers only the requested
  // one, so listing the rest is what shows the admin that a client with a familiar
  // name also carries an attacker's redirect.
  const others = (registeredUris ?? []).filter((u) => u !== oauthReq.redirectUri);
  const othersHtml = others.length
    ? `<p>This client also has these registered redirect URIs (not covered by this approval):</p><ul>${others
        .map((u) => `<li><code>${escapeHtml(u)}</code></li>`)
        .join("")}</ul>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
.card { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-all; }
button { background: #1a7f37; color: #fff; border: 0; border-radius: 6px; padding: 0.6rem 1.4rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<div class="card">
<h1>Capsid access request</h1>
<p><strong>${name}</strong> is asking to connect to this MCP server.</p>
<p>Requested redirect URI: <code>${redirect}</code></p>
${othersHtml}
<p>Approving will send you to GitHub to sign in. Only the configured admin account is admitted.</p>
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="req" value="${req}">
<button type="submit">Approve and continue to GitHub</button>
</form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      // The static headers, and why form-action is absent from the CSP: see
      // CONSENT_DIALOG_HEADERS in ./headers.
      ...CONSENT_DIALOG_HEADERS,
      "Set-Cookie": `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=${STATE_TTL_SECONDS}`,
    },
  });
}

async function startGithubFlow(
  request: Request,
  env: Env,
  oauthReq: AuthRequest,
  extraCookies: string[] = []
): Promise<Response> {
  return startGithubLogin(request, env, MCP_LOGIN, JSON.stringify(oauthReq), extraCookies);
}

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return textResponse(`invalid authorization request: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  if (!oauthReq.clientId) return textResponse("invalid authorization request: missing client_id", 400);
  // The lookup runs before the cookie check: the approval is bound to this client's
  // redirect set, and reading the client is the only way to check it. A client id
  // that no longer resolves cannot ride an old cookie past the dialog.
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return textResponse("unknown client", 400);
  const approved = await approvedClients(request, env.COOKIE_ENCRYPTION_KEY);
  if (approved.includes(await approvalTag(oauthReq.clientId, oauthReq.redirectUri))) {
    return startGithubFlow(request, env, oauthReq);
  }
  return renderApprovalDialog(oauthReq, client.clientName ?? oauthReq.clientId, crypto.randomUUID(), client.redirectUris);
}

// The consent form's body cap. `req` is a base64url AuthRequest and `csrf` a uuid, so
// a real submission is well under a kilobyte; 64KB leaves headroom and still refuses
// a body that is trying to be something else.
const AUTHORIZE_FORM_MAX_BYTES = 65_536;

async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  // Bounded at the stream, before the parse. request.formData() buffers and parses
  // the whole body before any check here runs, on a path reachable without
  // credentials: the CSRF cookie is checked after the parse, and a caller can fetch
  // the form to obtain one.
  const bounded = await readBoundedText(request, AUTHORIZE_FORM_MAX_BYTES);
  if (!bounded.ok) return new Response(null, { status: 413 });
  // URLSearchParams, not formData(): the dialog is a plain `<form method="post">` with
  // no enctype, so the browser sends urlencoded, and so does the live gate.
  const form = new URLSearchParams(bounded.text);
  const csrf = form.get("csrf");
  const req = form.get("req");
  if (typeof csrf !== "string" || typeof req !== "string") return textResponse("bad request", 400);
  const csrfCookie = getCookie(request, CSRF_COOKIE);
  if (!csrfCookie || !timingSafeEqual(csrfCookie, csrf)) return textResponse("csrf validation failed: restart the flow", 403);
  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(b64urlDecode(req)) as AuthRequest;
  } catch {
    return textResponse("bad request", 400);
  }
  const client = oauthReq.clientId ? await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId) : null;
  if (!client) return textResponse("unknown client", 400);
  const approved = await approvedClients(request, env.COOKIE_ENCRYPTION_KEY);
  const tag = await approvalTag(oauthReq.clientId, oauthReq.redirectUri);
  if (!approved.includes(tag)) approved.push(tag);
  const cookies = [
    await approvalCookie(approved, env.COOKIE_ENCRYPTION_KEY),
    `${CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0`,
  ];
  return startGithubFlow(request, env, oauthReq, cookies);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const login = await completeGithubLogin(request, env, MCP_LOGIN, (stored) => JSON.parse(stored) as AuthRequest);
  if (!login.ok) return login.response;
  const { user, state: oauthReq } = login;

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: oauthReq.scope,
    props: { id: user.id, login: user.login, name: user.name ?? null },
  });

  const headers = new Headers({ Location: redirectTo });
  headers.append("Set-Cookie", clearStateCookie(MCP_LOGIN));
  return new Response(null, { status: 302, headers });
}

async function handleOperatorMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The bearer is resolved to a caller once, here, and every tool in this request is
  // checked against it. A minted agent carries the scopes its row says; a legacy
  // operator key resolves to the unrestricted caller until it is revoked by hand.
  const resolved = await resolveAgent(request, env);
  if (!resolved) {
    return new Response("unauthorized: valid operator key or agent key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  // last_seen is not part of authorizing, so a slow or failing write rides on
  // waitUntil rather than slowing the tool call.
  ctx.waitUntil(resolved.touch());
  return createMcpHandler(buildServer(env, resolved.agent), { route: "/ops/mcp" })(request, env, ctx);
}

async function handleBackup(request: Request, env: Env): Promise<Response> {
  // No credential, or one that resolves to nobody: 401, so a client knows to send one.
  const caller = await resolveAgent(request, env);
  if (!caller) {
    return new Response("unauthorized: admin operator key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  // A caller that resolved but may not run this: 403. A backup and its prune cover
  // every namespace, so ROUTE_GRANTS in src/scope.ts requires the admin, through the
  // same checkScope the tools use. The write grant alone is held by every
  // namespace-scoped driver.
  const refusal = routeRefusal("/ops/backup", caller.agent);
  if (refusal) return new Response(refusal, { status: 403 });
  const result = await runBackup(env);
  // 409 when another run holds the lease, so "did nothing" is visible without the body.
  return Response.json(result, { status: result.ran ? 200 : 409 });
}

const CSP_REPORT_MAX_BYTES = 16384;
// application/csp-report is the legacy report-uri type; application/reports+json is
// the Reporting API type, which is what the COOP trial sends.
const CSP_REPORT_TYPES = ["application/csp-report", "application/reports+json"];

// A report, or not. Structural rather than a schema: the two wire formats disagree
// on every key name, and browsers add fields.
function looksLikeReport(parsed: unknown): boolean {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const legacy = (parsed as { "csp-report"?: unknown })["csp-report"];
    return Boolean(legacy) && typeof legacy === "object";
  }
  if (Array.isArray(parsed)) {
    return parsed.length > 0 && parsed.every((entry) => Boolean(entry) && typeof entry === "object" && "body" in (entry as object));
  }
  return false;
}

function summarizeReport(parsed: unknown): { directive: string; blocked: string; document: string } {
  // Two wire formats reach here. report-uri sends {"csp-report": {...}} with
  // hyphenated keys; the Reporting API (report-to) sends an array of
  // {type, body} with camelCase keys, and COOP reports arrive that way too.
  const legacy = (parsed as { "csp-report"?: Record<string, unknown> } | null)?.["csp-report"];
  if (legacy) {
    return {
      directive: String(legacy["effective-directive"] ?? legacy["violated-directive"] ?? "?"),
      blocked: String(legacy["blocked-uri"] ?? "?"),
      document: String(legacy["document-uri"] ?? "?"),
    };
  }
  const first = Array.isArray(parsed) ? (parsed[0] as { type?: string; body?: Record<string, unknown> }) : null;
  if (first?.body) {
    return {
      directive: String(first.body.effectiveDirective ?? first.type ?? "?"),
      blocked: String(first.body.blockedURL ?? "?"),
      document: String(first.body.documentURL ?? "?"),
    };
  }
  return { directive: "?", blocked: "?", document: "?" };
}

async function handleCspReport(request: Request, env: Env): Promise<Response> {
  // Rate limited first, before the body is read: every accepted report becomes an R2
  // object, so this is the Worker's most expensive unauthenticated write per call.
  // The refusal is a 429 rather than the usual 204 (see rateLimitedResponse).
  const ip = callerIp(request);
  const rate = await checkRate(env.APP_KV, ip, new Date(), CSP_REPORT_LIMIT);
  if (!rate.allowed) {
    // The unavailable refusal has already logged itself.
    if (rate.window !== "unavailable") {
      console.error(`CSP_REPORT_RATE_LIMITED ${ip} hit the ${rate.window} limit (${rate.count} of ${rate.limit})`);
    }
    return rateLimitedResponse(rate);
  }

  // Content-Type first, before the body is even read.
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!CSP_REPORT_TYPES.includes(contentType)) {
    return new Response(`unsupported content type: expected one of ${CSP_REPORT_TYPES.join(", ")}`, {
      status: 415,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  }
  // Bounded at the stream, in bytes: readBoundedText cancels on the chunk that
  // crosses the cap. Reading the whole text first would buffer an unbounded body on a
  // public unauthenticated path, and a length check on text counts UTF-16 units, so a
  // body of multi-byte characters would pass a cap named in bytes at three times it.
  const bounded = await readBoundedText(request, CSP_REPORT_MAX_BYTES);
  if (!bounded.ok) return new Response(null, { status: 413 });
  const raw = bounded.text;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response("body is not JSON", { status: 400, headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }
  if (!looksLikeReport(parsed)) {
    return new Response('body is not a violation report: expected {"csp-report": {...}} or a non-empty array of {type, body}', {
      status: 400,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  }

  const now = new Date();
  // The request's cf-ray has no colo suffix; the response's does. A report keys as
  // "a29fb43b4ac66c31.json", not "a29fb43b4ac66c31-DFW.json", so looking one up by the
  // ray off a response finds no such key against an object that is present.
  const ray = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const key = `${REPORT_PREFIX}${now.toISOString().slice(0, 10)}/${ray}.json`;
  const summary = summarizeReport(parsed);

  console.log(
    JSON.stringify({
      kind: "csp-violation",
      key,
      directive: summary.directive,
      blocked: summary.blocked,
      document: summary.document,
    })
  );

  await env.MEDIA.put(
    key,
    JSON.stringify(
      {
        received_at: now.toISOString(),
        ray,
        content_type: request.headers.get("Content-Type"),
        user_agent: request.headers.get("User-Agent"),
        summary,
        report: parsed,
      },
      null,
      2
    ),
    { httpMetadata: { contentType: "application/json" } }
  );

  return new Response(null, { status: 204 });
}

// /health lives in src/health.ts: routes.ts pulls cloudflare:workers via the Agents
// SDK and cannot load under node --test.

// The header names differ per endpoint; everything downstream of this is shared.
function signedHeaders(request: Request, kind: "improve" | "backup"): { namespace: string; timestamp: string; signature: string } {
  if (kind === "backup") {
    return {
      namespace: "",
      timestamp: request.headers.get("X-Backup-Timestamp") ?? "",
      signature: request.headers.get("X-Backup-Signature") ?? "",
    };
  }
  return {
    namespace: request.headers.get("X-Improve-Namespace") ?? "",
    timestamp: request.headers.get("X-Improve-Timestamp") ?? "",
    signature: request.headers.get("X-Improve-Signature") ?? "",
  };
}

async function readSignedBody(
  request: Request,
  tooLarge: string,
  declaredTooLarge?: (n: number) => string
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  if (declaredTooLarge) {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
      return { ok: false, response: textResponse(declaredTooLarge(declared), 413) };
    }
  }
  const bounded = await readBoundedText(request, MAX_REPORT_BYTES);
  if (!bounded.ok) return { ok: false, response: textResponse(tooLarge, 413) };
  return { ok: true, body: bounded.text };
}

// The backup-credential mint. Same shape as the holdout mint below, with the
// backup-specific derived key and no namespace: one hour of object-read-only on
// backups/json/. The jti cache runs under the literal scope "backup", which is not
// in ROSTER.
async function handleBackupCredential(request: Request, env: Env): Promise<Response> {
  const { timestamp, signature } = signedHeaders(request, "backup");

  const bounded = await readSignedBody(request, `request too large: exceeds ${MAX_REPORT_BYTES} bytes`);
  if (!bounded.ok) return bounded.response;
  const body = bounded.body;

  const verdict = await verifyBackupCredentialRequest(env, { timestamp, signature, body }, new Date());
  if (!verdict.ok) {
    console.error(`BACKUP_CREDENTIAL_REJECTED ${verdict.refusal}`);
    return textResponse(verdict.refusal, verdict.status);
  }

  const parsed = parseBackupCredentialRequest(body);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);

  const claim = await claimJti(env.DB, "backup", parsed.jti);
  if (!claim.ok) return textResponse(claim.refusal, claim.status);

  const minted = await mintBackupCredential(env);
  if (!minted.ok) {
    console.error(`BACKUP_CREDENTIAL_FAILED ${minted.refusal}`);
    return textResponse(minted.refusal, minted.status);
  }
  console.log(`BACKUP_CREDENTIAL_MINTED ttl=${minted.credential.expires_in}s`);
  return new Response(JSON.stringify(minted.credential), { status: 200, headers: { "Content-Type": "application/json" } });
}

// The holdout-credential mint. Same envelope as the score report: per-namespace HMAC
// over timestamp.body, bounded body, jti replay cache. The signed namespace is the
// authority, so a repo can mint read access to its own holdout prefix only.
async function handleHoldoutCredential(request: Request, env: Env): Promise<Response> {
  const { namespace, timestamp, signature } = signedHeaders(request, "improve");

  const bounded = await readSignedBody(request, `request too large: exceeds ${MAX_REPORT_BYTES} bytes`);
  if (!bounded.ok) return bounded.response;
  const body = bounded.body;

  const verdict = await verifySignedReport(env, { namespace, timestamp, signature, body }, new Date());
  if (!verdict.ok) {
    console.error(`IMPROVE_CREDENTIAL_REJECTED ${namespace || "(no namespace)"}: ${verdict.refusal}`);
    return textResponse(verdict.refusal, verdict.status);
  }

  const parsed = parseCredentialRequest(body);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);
  if (parsed.namespace !== verdict.namespace) {
    return textResponse(
      `the request body names namespace '${parsed.namespace}' but it was signed with the key for '${verdict.namespace}'`,
      403
    );
  }

  const claim = await claimJti(env.DB, verdict.namespace, parsed.jti);
  if (!claim.ok) return textResponse(claim.refusal, claim.status);

  const minted = await mintHoldoutCredential(env, verdict.namespace);
  if (!minted.ok) {
    console.error(`IMPROVE_CREDENTIAL_FAILED ${verdict.namespace}: ${minted.refusal}`);
    return textResponse(minted.refusal, minted.status);
  }
  console.log(`IMPROVE_CREDENTIAL_MINTED ns=${verdict.namespace} ttl=${minted.credential.expires_in}s`);
  return new Response(JSON.stringify(minted.credential), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// The score report sink. CI posts here when it has finished scoring a branch.
//
// Not under /ops/. An /ops/ path is opened by an operator key, which can write every
// document in the store. Several repos reach this endpoint, so it is opened by a
// per-namespace HMAC derived from one Worker secret: a key leaking from one repo's
// Actions log authorizes reports for that namespace only.
//
// No rate limiter, unlike /csp-report, which takes an unauthenticated write into R2.
// This one writes nothing until a signature over the body verifies, so an unsigned
// flood costs two HMAC computations per request and reaches no storage.
async function handleImproveScore(request: Request, env: Env): Promise<Response> {
  const { namespace, timestamp, signature } = signedHeaders(request, "improve");

  // Bounded before any HMAC. The Content-Length check rejects a declared-large body
  // cheaply but fires only when the header is present and honest; the bounded reader
  // is the enforcement, and it stops pulling from the stream once MAX_REPORT_BYTES is
  // exceeded, so neither memory nor crypto is spent.
  const bounded = await readSignedBody(
    request,
    `report too large: exceeds ${MAX_REPORT_BYTES} bytes`,
    (declared) => `report too large: ${declared} bytes exceeds ${MAX_REPORT_BYTES}`
  );
  if (!bounded.ok) return bounded.response;
  const body = bounded.body;

  const verdict = await verifySignedReport(env, { namespace, timestamp, signature, body }, new Date());
  if (!verdict.ok) {
    console.error(`IMPROVE_SCORE_REJECTED ${namespace || "(no namespace)"}: ${verdict.refusal}`);
    return textResponse(verdict.refusal, verdict.status);
  }

  const parsed = parseScoreReport(body);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);

  // The signed namespace is the authority, not the one in the body. A body claiming a
  // different namespace is a repo reporting for a project it holds no key to.
  if (parsed.report.namespace !== verdict.namespace) {
    return textResponse(
      `the report body names namespace '${parsed.report.namespace}' but it was signed with the key for '${verdict.namespace}'`,
      403
    );
  }

  // Replay cache: the jti is inside the signed body, and a jti seen before for this
  // namespace is refused. claimJti fails closed on a store error.
  const claim = await claimJti(env.DB, verdict.namespace, parsed.report.jti);
  if (!claim.ok) {
    if (claim.status === 503) console.error(`IMPROVE_SCORE_REPLAY_KV_ERROR ${verdict.namespace}: ${claim.refusal}`);
    return textResponse(claim.refusal, claim.status);
  }

  const result = await ingestScore(env, parsed.report, new Date());
  return Response.json(result, { status: result.ok ? 200 : 409 });
}

export const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return handleHealth(env);
    if (url.pathname === REPORT_PATH && request.method === "POST") return handleCspReport(request, env);
    if (url.pathname === "/ops/mcp") return handleOperatorMcp(request, env, ctx);
    if (url.pathname === "/ops/backup" && request.method === "POST") return handleBackup(request, env);
    if (url.pathname === SCORE_PATH && request.method === "POST") return handleImproveScore(request, env);
    if (url.pathname === CREDENTIAL_PATH && request.method === "POST") return handleHoldoutCredential(request, env);
    if (url.pathname === BACKUP_CREDENTIAL_PATH && request.method === "POST") return handleBackupCredential(request, env);
    if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env);
    if (url.pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    if (url.pathname === CONSOLE_PATH && request.method === "GET") return handleConsole(request, env);
    if (url.pathname === CONSOLE_PATH && request.method === "POST") return handleConsoleAction(request, env);
    if (url.pathname === CONSOLE_JSON_PATH && request.method === "GET") return handleConsoleJson(request, env);
    if (url.pathname === CONSOLE_CALLBACK_PATH) return handleConsoleCallback(request, env, new Date());

    return new Response("not found", { status: 404 });
  },
};
