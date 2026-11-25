#!/usr/bin/env node
// Exercises capsid's OAuth consent surface against a deployed worker. Read-only; stops at the Access 302 and never drives Access.
// Two requirements, or the gate passes against a broken server: (1) a form, never a redirect: a 302 at gate 3 means consent was
// skipped and the run is VOID, and the probe client is a fixed metadata document (scripts/cimd-probe-lib.mjs); (2) poll header
// assertions, never single-fetch: the first post-deploy read can return the previous version's headers.

import { checkSecurityHeaders, failures } from "@dustinedwards/site-runtime/check";
import { CANARY_CLIENT, OAUTH_KV } from "./bindings.mjs";
import { accessRedirectProblem } from "./access-redirect-lib.mjs";
import { canaryReport, checkCanary } from "./canary-lib.mjs";
import {
  PROBE_REDIRECT,
  probeClientId,
  probeDocumentProblem,
  registrationProblem,
} from "./cimd-probe-lib.mjs";
import { checkBackupFreshness } from "./freshness-lib.mjs";
import { probeMcp } from "./mcp-probe-lib.mjs";

import { errorMessage } from "@dustinedwards/site-runtime/log";
const ORIGIN = (process.argv[2] ?? "https://mcp.dustinedwards.info").replace(/\/$/, "");
// Overridable because CI's sha gate waits on a rollout that has only just started and needs a longer budget.
const POLL_ATTEMPTS = Number(process.env.VERIFY_POLL_ATTEMPTS ?? 10);
const POLL_INTERVAL_MS = Number(process.env.VERIFY_POLL_INTERVAL_MS ?? 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A gate that got no answer has not refused anything: a thrown fetch is retried, and a gate whose requests all throw is COULD NOT RUN.
// The script then exits 3 rather than 1 when nothing failed; the live gate rolls back on exit 1 only.
const FETCH_TRIES = Number(process.env.VERIFY_FETCH_TRIES ?? 3);
const FETCH_TIMEOUT_MS = Number(process.env.VERIFY_FETCH_TIMEOUT_MS ?? 20000);
const EXIT_REFUSED = 1;
const EXIT_COULD_NOT_RUN = 3;

class NoAnswer extends Error {
  constructor(url, cause) {
    super(`no answer from ${String(url).split("?")[0]}: ${errorMessage(cause)}`);
  }
}

// During devkit worker-deploy's gradual rollout WORKERS_VERSION_OVERRIDE names the new version; every request carries it as Cloudflare-Workers-Version-Overrides so each gate judges it, not whichever one the split picks.
const VERSION_OVERRIDE = process.env.WORKERS_VERSION_OVERRIDE ?? "";

// One request, body read included (a reset can land mid-body). Retries a throw `tries` times, then throws NoAnswer; a response
// of any status is an answer. Gates that poll one URL pass tries=1, because the poll loop is their retry.
async function request(url, init = {}, tries = FETCH_TRIES) {
  const headers = VERSION_OVERRIDE
    ? { ...init.headers, "Cloudflare-Workers-Version-Overrides": VERSION_OVERRIDE }
    : init.headers;
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await resp.text();
      return { status: resp.status, ok: resp.ok, headers: resp.headers, text };
    } catch (err) {
      last = err;
      if (i < tries) await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new NoAnswer(url, last);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Rethrows anything but NoAnswer so a bug here still crashes.
function noAnswer(err) {
  if (err instanceof NoAnswer) return err;
  throw err;
}

const COULD_NOT_RUN = "could-not-run";
const results = [];
function record(gate, passed, detail) {
  results.push({ gate, passed, detail });
  const tag = passed === COULD_NOT_RUN ? "NORUN" : passed ? "PASS" : "FAIL";
  console.log(`${tag}  ${gate}\n      ${detail}`);
}

// The same response shows the store is bound and the FTS index intact (a Worker on a stale wrangler.jsonc still answers /health). The FTS probe is a MATCH pinned to one document, because COUNT(*) and integrity-check pass on an emptied external-content index.
// pass or warn is up (a warn is a stale backup or quiet task, which gate 1c and the Portal report), fail is a 503. "ok" is the shape before 2026-10-31, which a rollback still serves.
function isUp(status) {
  return status === "pass" || status === "warn" || status === "ok";
}

async function gateHealth() {
  const expected = process.env.EXPECT_SHA;
  let data = null;
  let attempt = 0;
  let lost = null;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await request(`${ORIGIN}/health`, { headers: { "Cache-Control": "no-cache" } }, 1);
      lost = null;
    } catch (err) {
      lost = noAnswer(err);
      if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
      continue;
    }
    data = parseJson(resp.text);
    // Keep polling through any not-yet-converged state, including a non-JSON response: the previous version may still be serving.
    const storeOk = data?.store?.d1 === "ok" && data?.store?.fts === "ok";
    const converged =
      resp.status === 200 && isUp(data?.status) && (!expected || data.sha === expected) && storeOk;
    if (converged) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  if (lost) {
    record(
      "1 health + provenance",
      COULD_NOT_RUN,
      `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`,
    );
    return;
  }
  const live = isUp(data?.status);
  const shaOk = !expected || data?.sha === expected;
  const d1 = data?.store?.d1 ?? "(absent)";
  const fts = data?.store?.fts ?? "(absent)";
  const passed = live && shaOk && d1 === "ok" && fts === "ok";
  const detail =
    `status=${data?.status ?? "?"} sha=${(data?.sha ?? "?").slice(0, 8)} d1=${d1} fts=${fts} polls=${attempt}` +
    (expected ? ` expected=${expected.slice(0, 8)}${shaOk ? " MATCH" : " MISMATCH"}` : "");
  record("1 health + provenance", passed, detail);
}

// Overridable only so test/verify-live-no-answer.test.ts can serve the document from its stub.
const PROBE_CLIENT = process.env.VERIFY_PROBE_CLIENT_ID ?? probeClientId(ORIGIN);

// The Worker under test serves the probe document: no answer is could-not-run; a non-200 or a wrong document is this deploy's fault.
async function gateCimdAndDcr() {
  let metadata;
  let register;
  try {
    metadata = await request(`${ORIGIN}/.well-known/oauth-authorization-server`, {
      headers: { "Cache-Control": "no-cache" },
    });
    // Safe to retry: the probe's redirect is on no allowlist, so nothing is written.
    register = await request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "capsid verify-live probe",
        redirect_uris: [PROBE_REDIRECT],
        token_endpoint_auth_method: "none",
      }),
    });
  } catch (err) {
    record("2 CIMD, DCR allowlisted", COULD_NOT_RUN, noAnswer(err).message);
    return null;
  }
  const refused = registrationProblem(
    parseJson(metadata.text),
    ORIGIN,
    register.status,
    parseJson(register.text),
  );
  if (refused) {
    record("2 CIMD, DCR allowlisted", false, `register=${register.status}: ${refused}`);
    return null;
  }
  // Polled like gates 1 and 6: the first reads after a deploy can reach the previous version (2026-10-10, dbd5e21 failed on a single read one second after gate 1 saw the new sha).
  let doc;
  let attempt = 0;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    try {
      doc = await request(PROBE_CLIENT, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
    } catch (err) {
      record(
        "2 CIMD, DCR allowlisted",
        COULD_NOT_RUN,
        `the probe document could not be read: ${noAnswer(err).message}`,
      );
      return COULD_NOT_RUN;
    }
    if (doc.ok) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  if (!doc.ok) {
    const body = doc.text.slice(0, 80).replace(/\s+/g, " ");
    record(
      "2 CIMD, DCR allowlisted",
      false,
      `the probe document answered ${doc.status} at ${PROBE_CLIENT} (polls=${Math.min(attempt, POLL_ATTEMPTS)} server=${doc.headers.get("server") ?? "?"} body=${JSON.stringify(body)})`,
    );
    return null;
  }
  const bad = probeDocumentProblem(parseJson(doc.text), PROBE_CLIENT, PROBE_REDIRECT);
  record(
    "2 CIMD, DCR allowlisted",
    bad === null,
    `register=${register.status} probe=${PROBE_CLIENT} polls=${attempt}${bad ? `: ${bad}` : ""}`,
  );
  return bad === null ? PROBE_CLIENT : null;
}

// The KV REST status separates 200 (PASS), 404 (FAIL, data loss) and anything else (FAIL, not data loss).
// Write the gate label out at every record() call: test/counts.test.ts counts distinct literal labels, so a label behind a variable is a gate the count cannot see.
async function gateCanary() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const key = `client:${CANARY_CLIENT.id}`;

  // No credentials: assert nothing and say so, rather than failing an interactive run that never had a token.
  if (!account || !token) {
    record(
      "2b canary client record",
      true,
      `SKIPPED: no CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN, so ${key} was not read. This run asserts nothing about it.`,
    );
    return;
  }

  const retryingFetch = async (url, init) => {
    let last;
    for (let i = 1; i <= FETCH_TRIES; i++) {
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (err) {
        last = err;
        if (i < FETCH_TRIES) await sleep(POLL_INTERVAL_MS);
      }
    }
    throw last;
  };
  const result = await checkCanary({
    fetchImpl: retryingFetch,
    base: `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${OAUTH_KV.id}`,
    clientId: CANARY_CLIENT.id,
    auth: { Authorization: `Bearer ${token}` },
  });
  const { passed, detail } = canaryReport(result, CANARY_CLIENT.id, OAUTH_KV.name);
  // UNREACHABLE and TTL-UNVERIFIED say nothing about this deploy: could-not-run, no rollback.
  const unread = result.outcome === "unreachable" || result.outcome === "ttl-unverified";
  record("2b canary client record", unread ? COULD_NOT_RUN : passed, detail);
}

function authorizeUrl(clientId) {
  const u = new URL(`${ORIGIN}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", PROBE_REDIRECT);
  u.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "verify-live");
  u.searchParams.set("resource", `${ORIGIN}/mcp`);
  return u.href;
}

async function gateBackupFreshness() {
  const assertFresh = process.env.ASSERT_BACKUP_FRESH === "1";
  let data = null;
  try {
    const resp = await request(`${ORIGIN}/health`, { headers: { "Cache-Control": "no-cache" } });
    data = parseJson(resp.text);
  } catch (err) {
    data = null;
    if (assertFresh) {
      record(
        "1c backup freshness",
        COULD_NOT_RUN,
        `/health could not be read: ${noAnswer(err).message}`,
      );
      return;
    }
  }
  const verdict = checkBackupFreshness(data, { assert: assertFresh });
  record("1c backup freshness", verdict.passed, verdict.detail);
}

// Gate 3: the consent form renders. A 302 means the fast path was taken and the run is VOID, not a plain fail.
async function gateConsentForm(clientId) {
  let resp;
  try {
    resp = await request(authorizeUrl(clientId), { redirect: "manual" });
  } catch (err) {
    record("3 consent form renders", COULD_NOT_RUN, noAnswer(err).message);
    return COULD_NOT_RUN;
  }
  if (resp.status >= 300 && resp.status < 400) {
    record(
      "3 consent form renders",
      false,
      `VOID: got ${resp.status} redirect, not a form. The fast path was hit, so this run proves nothing. Check that the client id is genuinely new.`,
    );
    return null;
  }
  const html = resp.text;
  const hasForm = /<form[^>]+method=["']post["']/i.test(html);
  const handle = html.match(/name=["']handle["'][^>]*value=["']([^"']+)["']/i)?.[1];
  const cookies = resp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const passed = resp.status === 200 && hasForm && Boolean(handle) && Boolean(cookies);
  record(
    "3 consent form renders",
    passed,
    `status=${resp.status} form=${hasForm} handle_field=${Boolean(handle)} consent_cookie=${Boolean(cookies)}`,
  );
  return passed ? { handle, cookies } : null;
}

async function gateCsp(clientId) {
  let csp = null;
  let attempt = 0;
  let lost = null;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    try {
      const resp = await request(authorizeUrl(clientId), { redirect: "manual" }, 1);
      lost = null;
      csp = resp.headers.get("content-security-policy");
      if (!csp || !/form-action/i.test(csp)) break;
    } catch (err) {
      lost = noAnswer(err);
    }
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  if (lost) {
    record(
      "4 consent CSP permits the chain",
      COULD_NOT_RUN,
      `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`,
    );
    return;
  }
  // The redirect chain ends at whatever redirect_uri a client's metadata names, so no static form-action allowlist can be correct: absent is required, present fails.
  const passed = !csp || !/form-action/i.test(csp);
  record(
    "4 consent CSP permits the chain",
    passed,
    passed
      ? `polls=${attempt} csp=${csp ?? "(none)"}`
      : `polls=${attempt} form-action present after ${POLL_ATTEMPTS} polls: ${csp}`,
  );
}

// Only a live request proves every response reaches the header layer; workers-oauth-provider generates /token and both .well-known
// documents outside src/, so they are listed. The consent page and authorization-server metadata must carry no-store, and the CSP
// report sink must answer 204 (a browser posts once and never retries).
async function gateSecurityHeaders(clientId) {
  const consent = authorizeUrl(clientId);
  const report = JSON.stringify({
    "csp-report": {
      "document-uri": `${ORIGIN}/verify-live-probe`,
      "effective-directive": "verify-live-probe",
      "blocked-uri": "https://example.com/probe",
      note: "synthetic probe from scripts/verify-live.mjs, not a real violation",
    },
  });
  const surfaces = [
    ["/health", "json", { url: `${ORIGIN}/health` }],
    // inlineStyles: the consent dialog's policy (CONSENT_DIALOG_HEADERS) allows inline CSS on purpose, and its
    // default-src 'none' runs no script, so site-runtime's C11 is told rather than failed. Every other surface is held to it.
    [
      "/authorize consent",
      "html",
      { url: consent, init: { redirect: "manual" }, noStore: true, inlineStyles: true },
    ],
    ["/authorize bad req", "other", { url: `${ORIGIN}/authorize`, init: { redirect: "manual" } }],
    ["/callback no code", "other", { url: `${ORIGIN}/callback`, init: { redirect: "manual" } }],
    [
      ".well-known/as",
      "json",
      { url: `${ORIGIN}/.well-known/oauth-authorization-server`, noStore: true },
    ],
    [".well-known/prm", "json", { url: `${ORIGIN}/.well-known/oauth-protected-resource` }],
    [
      "/mcp 401",
      "any",
      {
        url: `${ORIGIN}/mcp`,
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      },
    ],
    [
      "/ops/mcp 401",
      "other",
      {
        url: `${ORIGIN}/ops/mcp`,
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      },
    ],
    // The MCP host serves the machine surface only (src/mcp-host.ts): a 302 here is the Portal on the wrong host, a 200 is the app served to anyone.
    [
      "/portal/ not on this host",
      "other",
      { url: `${ORIGIN}/portal/`, init: { redirect: "manual" }, status: 404 },
    ],
    // The Portal moved from /console with no redirects: each old address is the Worker's plain 404. A 302 is an added redirect, a 200 the old page back.
    [
      "/console gone",
      "other",
      { url: `${ORIGIN}/console`, init: { redirect: "manual" }, status: 404 },
    ],
    [
      "/console/app/ gone",
      "other",
      { url: `${ORIGIN}/console/app/`, init: { redirect: "manual" }, status: 404 },
    ],
    [
      "/console/callback gone",
      "other",
      { url: `${ORIGIN}/console/callback`, init: { redirect: "manual" }, status: 404 },
    ],
    ["/nope 404", "other", { url: `${ORIGIN}/nope` }],
    [
      "/csp-report",
      "other",
      {
        url: `${ORIGIN}/csp-report`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/csp-report" },
          body: report,
        },
        status: 204,
      },
    ],
  ];

  let problems = [];
  let attempt = 0;
  let lost = null;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    problems = [];
    lost = null;
    for (const [label, cls, { url, init, noStore, status, inlineStyles }] of surfaces) {
      let resp;
      try {
        resp = await request(url, {
          ...init,
          headers: { "Cache-Control": "no-cache", ...init?.headers },
        });
      } catch (err) {
        lost = noAnswer(err);
        break;
      }
      const h = (name) => resp.headers.get(name);

      if (status && resp.status !== status)
        problems.push(`${label}: status ${resp.status}, expected ${status}`);
      if (noStore && !/no-store/i.test(h("cache-control") ?? ""))
        problems.push(
          `${label}: cache-control ${h("cache-control") ?? "(none)"}, expected no-store`,
        );

      for (const r of failures(
        checkSecurityHeaders(resp.headers, {
          site: "capsid-mcp",
          ...(inlineStyles ? { inlineStyles } : {}),
        }),
      ))
        problems.push(`${label}: ${r.name}: ${r.detail}`);
      if (cls === "html" && !(h("content-type") ?? "").toLowerCase().includes("text/html"))
        problems.push(`${label}: expected html, got ${h("content-type")}`);
    }
    if (!lost && problems.length === 0) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  if (lost) {
    record(
      "6 security headers per class",
      COULD_NOT_RUN,
      `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`,
    );
    return;
  }
  record(
    "6 security headers per class",
    problems.length === 0,
    problems.length === 0
      ? `polls=${attempt} ${surfaces.length} surfaces clean`
      : `polls=${attempt} ${problems.length} problems: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? " ..." : ""}`,
  );
}

// The run stops here: it never follows the 302.
async function gateAccessRedirect(clientId, form) {
  const body = new URLSearchParams({ handle: form.handle, decision: "approve" });
  let resp;
  try {
    // Once only: the consent handle works once, so a retried POST would be refused.
    resp = await request(
      `${ORIGIN}/authorize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: form.cookies },
        body: body.toString(),
        redirect: "manual",
      },
      1,
    );
  } catch (err) {
    record("5 approve redirects to Access", COULD_NOT_RUN, noAnswer(err).message);
    return;
  }
  const location = resp.headers.get("location") ?? "";
  const problem = accessRedirectProblem(resp.status, location, ORIGIN);
  // The origin and path only: the query carries this run's state and nonce.
  const parsed = URL.canParse(location) ? new URL(location) : null;
  const shown = parsed ? parsed.origin + parsed.pathname : location || "(none)";
  record(
    "5 approve redirects to Access",
    problem === null,
    `status=${resp.status} location=${shown}${problem ? `: ${problem}` : ""} (not followed)`,
  );
}

// Gate 7: the Portal on its own host (src/portal-host.ts). Without a session its root and any other path (here /mcp, which must not reach the MCP endpoint)
// redirect to the Access sign-in, from the Worker's login or Access at the edge; never the app, never a 401 from /mcp. Not followed.
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN ?? "https://portal.dustinedwards.info").replace(
  /\/$/,
  "",
);
async function gatePortalHost() {
  const problems = [];
  for (const path of ["/", "/mcp"]) {
    let resp;
    try {
      resp = await request(`${PORTAL_ORIGIN}${path}`, {
        redirect: "manual",
        headers: { "Cache-Control": "no-cache" },
      });
    } catch (err) {
      record(
        "7 Portal host sends to Access",
        COULD_NOT_RUN,
        `${PORTAL_ORIGIN}${path}: ${noAnswer(err).message}`,
      );
      return;
    }
    const location = resp.headers.get("location") ?? "";
    const host = URL.canParse(location) ? new URL(location).hostname : "";
    if (resp.status !== 302 || !host.endsWith(".cloudflareaccess.com")) {
      problems.push(
        `${path}: status ${resp.status}, location host ${host || "(none)"}; expected 302 to the Access team domain`,
      );
    }
  }
  record(
    "7 Portal host sends to Access",
    problems.length === 0,
    problems.length === 0
      ? `${PORTAL_ORIGIN} / and /mcp redirect to Access (not followed)`
      : problems.join("; "),
  );
}

// The only gate that reaches the tools, so the only one that sees a deploy whose sign-in works and whose connection does not.
// A refusal exits 1 and ci.yml rolls the deploy back. No key: assert nothing and say so, as gate 2b does without its token.
async function gateMcpCall() {
  const key = process.env.CAPSID_LIVE_PROBE_KEY;
  if (!key) {
    record(
      "8 MCP call through /ops/mcp",
      true,
      "SKIPPED: no CAPSID_LIVE_PROBE_KEY, so no MCP call was made. This run asserts nothing about the connection.",
    );
    if (process.env.GITHUB_ACTIONS)
      console.log(
        "::warning::live gate 8 skipped: the CAPSID_LIVE_PROBE_KEY secret is not set, so this deploy's MCP connection was not checked.",
      );
    return;
  }
  const post = async (body, headers) => {
    const resp = await request(`${ORIGIN}/ops/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Cache-Control": "no-cache",
        ...headers,
      },
      body,
    });
    return { status: resp.status, text: resp.text };
  };
  let problems = [];
  let attempt = 0;
  let lost = null;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    lost = null;
    try {
      problems = await probeMcp(post);
    } catch (err) {
      lost = noAnswer(err);
    }
    if (!lost && problems.length === 0) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  if (lost) {
    record(
      "8 MCP call through /ops/mcp",
      COULD_NOT_RUN,
      `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`,
    );
    return;
  }
  record(
    "8 MCP call through /ops/mcp",
    problems.length === 0,
    problems.length === 0
      ? `polls=${attempt} 2025-11-25 and 2026-07-28: handshake, tools/list, read`
      : `polls=${attempt} ${problems.join("; ")}`,
  );
}

const clientId = await (async () => {
  await gateHealth();
  await gateBackupFreshness();
  await gateCanary();
  return gateCimdAndDcr();
})();

const upstream = (gate) =>
  results.find((r) => r.gate === gate)?.passed === COULD_NOT_RUN ? COULD_NOT_RUN : false;

if (clientId && clientId !== COULD_NOT_RUN) {
  const form = await gateConsentForm(clientId);
  await gateCsp(clientId);
  await gateSecurityHeaders(clientId);
  if (form && form !== COULD_NOT_RUN) await gateAccessRedirect(clientId, form);
  else
    record(
      "5 approve redirects to Access",
      upstream("3 consent form renders"),
      "skipped: gate 3 did not yield a usable form",
    );
} else {
  record(
    "3 consent form renders",
    upstream("2 CIMD, DCR allowlisted"),
    "skipped: no probe client from gate 2",
  );
}
await gatePortalHost();
await gateMcpCall();

// process.exitCode rather than process.exit(): exiting with fetch sockets still closing
// trips a libuv assertion on Windows and replaces the exit code with 3221226505.
const failed = results.filter((r) => r.passed === false);
const norun = results.filter((r) => r.passed === COULD_NOT_RUN);
console.log(
  `\n${results.length - failed.length - norun.length}/${results.length} gates passed against ${ORIGIN}`,
);
if (failed.length) {
  console.log(`FAILED GATES: ${failed.map((f) => f.gate).join(", ")}`);
  if (norun.length) console.log(`COULD NOT RUN: ${norun.map((f) => f.gate).join(", ")}`);
  process.exitCode = EXIT_REFUSED;
} else if (norun.length) {
  console.log(
    `COULD NOT RUN: ${norun.map((f) => f.gate).join(", ")}. No gate refused this deploy; exiting ${EXIT_COULD_NOT_RUN} so it is not rolled back.`,
  );
  process.exitCode = EXIT_COULD_NOT_RUN;
}
