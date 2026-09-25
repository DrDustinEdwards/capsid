#!/usr/bin/env node
// verify-live: exercises capsid's OAuth consent surface against a deployed worker.
// Read-only. Stops at the GitHub 302 and never drives GitHub.
//
// Usage: node scripts/verify-live.mjs [origin]
//        npm run verify:live
//
// tsc and node --test never touch a live surface; this does.
//
// Two hard requirements. Violating either makes this gate pass against a fully broken
// server:
//
//   1. FRESH CLIENT EVERY RUN. handleAuthorizeGet short-circuits for a client id
//      already in the capsid_approved cookie and 302s straight out of the GET, never
//      rendering a form. This registers a new client per run and asserts the consent
//      FORM renders. A 302 at gate 3 means the fast path was hit and the run is VOID.
//
//   2. POLL, NEVER SINGLE-FETCH, on header assertions. The first post-deploy read can
//      return the previous version's headers.

import { writeFileSync } from "node:fs";
import { CANARY_CLIENT, OAUTH_KV } from "./bindings.mjs";
import { canaryReport, checkCanary } from "./canary-lib.mjs";
import { checkBackupFreshness } from "./freshness-lib.mjs";

const ORIGIN = (process.argv[2] ?? "https://capsid.dustin-edwards.workers.dev").replace(/\/$/, "");
// Overridable because CI's sha gate waits on a rollout that has only just started and
// needs a longer budget than an interactive run.
const POLL_ATTEMPTS = Number(process.env.VERIFY_POLL_ATTEMPTS ?? 10);
const POLL_INTERVAL_MS = Number(process.env.VERIFY_POLL_INTERVAL_MS ?? 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A GATE THAT GOT NO ANSWER HAS NOT REFUSED ANYTHING. A thrown fetch is retried; a gate
// whose requests all throw is recorded as COULD NOT RUN, and the script exits 3 instead
// of 1 when nothing actually failed. ci.yml rolls back on exit 1 only.
const FETCH_TRIES = Number(process.env.VERIFY_FETCH_TRIES ?? 3);
const FETCH_TIMEOUT_MS = Number(process.env.VERIFY_FETCH_TIMEOUT_MS ?? 20000);
const EXIT_REFUSED = 1;
const EXIT_COULD_NOT_RUN = 3;

class NoAnswer extends Error {
  constructor(url, cause) {
    super(`no answer from ${String(url).split("?")[0]}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

// One request, body read included, since a reset can also land mid-body. Retries a
// throw `tries` times and then throws NoAnswer. A response of any status is an answer
// and is returned as is. Gates that poll one URL pass tries=1, because the poll loop is
// their retry.
async function request(url, init = {}, tries = FETCH_TRIES) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

// Rethrows anything that is not a NoAnswer, so a bug in this script still crashes.
function noAnswer(err) {
  if (err instanceof NoAnswer) return err;
  throw err;
}

const COULD_NOT_RUN = "could-not-run";
const results = [];
// passed is true, false, or COULD_NOT_RUN.
function record(gate, passed, detail) {
  results.push({ gate, passed, detail });
  const tag = passed === COULD_NOT_RUN ? "NORUN" : passed ? "PASS" : "FAIL";
  console.log(`${tag}  ${gate}\n      ${detail}`);
}

// Gate 1: liveness and deploy provenance. /health returns the git sha stamped at deploy
// time; EXPECT_SHA asserts it.
//
// The same response shows the store is bound and the FTS index is intact: a Worker
// deployed against a stale wrangler.jsonc still answers /health, and the other gates
// never touch D1. /health's FTS probe is a MATCH pinned to one document, because
// COUNT(*) and integrity-check both pass on an emptied external-content index.
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
      // A thrown fetch is a poll that has not converged yet, not a verdict.
      lost = noAnswer(err);
      if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
      continue;
    }
    data = parseJson(resp.text);
    // Keep polling through every not-yet-converged state, including a response that is
    // not JSON: immediately after a deploy the previous version may still be serving.
    const storeOk = data?.store?.d1 === "ok" && data?.store?.fts === "ok";
    const converged = resp.status === 200 && data?.status === "ok" && (!expected || data.sha === expected) && storeOk;
    if (converged) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }
  // The last poll got no answer, so whatever an earlier poll saw is not the verdict.
  if (lost) {
    record("1 health + provenance", COULD_NOT_RUN, `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`);
    return;
  }
  const live = data?.status === "ok";
  const shaOk = !expected || data?.sha === expected;
  const d1 = data?.store?.d1 ?? "(absent)";
  const fts = data?.store?.fts ?? "(absent)";
  const passed = live && shaOk && d1 === "ok" && fts === "ok";
  const detail = `status=${data?.status ?? "?"} sha=${(data?.sha ?? "?").slice(0, 8)} dirty=${data?.dirty} d1=${d1} fts=${fts} polls=${attempt}` +
    (expected ? ` expected=${expected.slice(0, 8)}${shaOk ? " MATCH" : " MISMATCH"}` : "");
  record("1 health + provenance", passed, detail);
  if (data?.dirty) console.log("      NOTE: deployed from a dirty tree; the bytes are not exactly that commit.");
}

// Gate 2: dynamic client registration. Returns a client id never seen before,
// which is what keeps gate 3 off the approved-client fast path.
async function gateRegister() {
  let resp;
  try {
    // A retry after a lost response can register a second client. That one is not
    // recorded for the reaper and expires on the registration TTL; a missed gate would
    // cost more.
    resp = await request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "capsid verify-live probe",
        redirect_uris: ["https://example.com/verify-live-callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
  } catch (err) {
    record("2 register (fresh client)", COULD_NOT_RUN, noAnswer(err).message);
    return null;
  }
  const data = parseJson(resp.text) ?? {};
  const clientId = data.client_id;
  const passed = resp.ok && typeof clientId === "string" && clientId.length > 0;
  record("2 register (fresh client)", passed, `status=${resp.status} client_id=${clientId ?? "(none)"}`);
  // Hand the id to scripts/reap-probe-clients.mjs, which has no other way to find it.
  // Written before any later gate can fail, so a failed run still gets cleaned up.
  if (passed && process.env.PROBE_CLIENT_FILE) {
    writeFileSync(process.env.PROBE_CLIENT_FILE, clientId, "utf8");
  }
  return passed ? clientId : null;
}

// Gate 2b: the canary client record is still there (scripts/bindings.mjs,
// CANARY_CLIENT). The KV REST API's status separates the cases:
//
//   200        the record is there                    PASS
//   404        the record is GONE                     FAIL, and it is data loss
//   anything   the store could not be read at all     FAIL, and it is NOT data loss
//
// The gate label is written out at every record() call rather than held in a variable.
// test/counts.test.ts counts DISTINCT literal labels to check the gate total, so a label
// behind a variable is a gate the count cannot see.
//
// The decision lives in ./canary-lib.mjs so it can be tested; this function is the
// wiring, plus the no-credentials case.
async function gateCanary() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const key = `client:${CANARY_CLIENT.id}`;

  // No credentials: assert nothing and SAY so, rather than passing quietly or failing an
  // interactive run that was never going to have a token.
  if (!account || !token) {
    record("2b canary client record", true, `SKIPPED: no CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN, so ${key} was not read. This run asserts nothing about it.`);
    return;
  }

  // Retries a thrown fetch like request() does, but hands checkCanary the Response.
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
  // UNREACHABLE means KV could not be read, and TTL-UNVERIFIED means its key list could
  // not be. Neither says anything about this deploy, so they are could-not-run and do
  // not roll it back.
  const unread = result.outcome === "unreachable" || result.outcome === "ttl-unverified";
  record("2b canary client record", unread ? COULD_NOT_RUN : passed, detail);
}

function authorizeUrl(clientId) {
  const u = new URL(`${ORIGIN}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", "https://example.com/verify-live-callback");
  u.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "verify-live");
  u.searchParams.set("resource", `${ORIGIN}/mcp`);
  return u.href;
}

// Gate 1c: backup freshness from /health's backup.last_ok, asserted on scheduled runs
// only. The rules live in scripts/freshness-lib.mjs.
async function gateBackupFreshness() {
  const assertFresh = process.env.ASSERT_BACKUP_FRESH === "1";
  let data = null;
  try {
    const resp = await request(`${ORIGIN}/health`, { headers: { "Cache-Control": "no-cache" } });
    data = parseJson(resp.text);
  } catch (err) {
    data = null;
    if (assertFresh) {
      record("1c backup freshness", COULD_NOT_RUN, `/health could not be read: ${noAnswer(err).message}`);
      return;
    }
  }
  const verdict = checkBackupFreshness(data, { assert: assertFresh });
  record("1c backup freshness", verdict.passed, verdict.detail);
}

// Gate 3: the consent FORM renders. A 302 here means the fast path was taken and
// the whole run is void, so that is reported as VOID rather than a plain fail.
async function gateConsentForm(clientId) {
  let resp;
  try {
    resp = await request(authorizeUrl(clientId), { redirect: "manual" });
  } catch (err) {
    record("3 consent form renders", COULD_NOT_RUN, noAnswer(err).message);
    return COULD_NOT_RUN;
  }
  if (resp.status >= 300 && resp.status < 400) {
    record("3 consent form renders", false, `VOID: got ${resp.status} redirect, not a form. The fast path was hit, so this run proves nothing. Check that the client id is genuinely new.`);
    return null;
  }
  const html = resp.text;
  const hasForm = /<form[^>]+method=["']post["'][^>]*action=["']\/authorize["']/i.test(html);
  const csrf = html.match(/name=["']csrf["'][^>]*value=["']([^"']+)["']/i)?.[1];
  const req = html.match(/name=["']req["'][^>]*value=["']([^"']+)["']/i)?.[1];
  const cookie = resp.headers.get("set-cookie") ?? "";
  const csrfCookie = cookie.match(/capsid_csrf=([^;]+)/)?.[1];
  const passed = resp.status === 200 && hasForm && Boolean(csrf) && Boolean(req) && Boolean(csrfCookie);
  record("3 consent form renders", passed, `status=${resp.status} form=${hasForm} csrf_field=${Boolean(csrf)} req_field=${Boolean(req)} csrf_cookie=${Boolean(csrfCookie)}`);
  return passed ? { csrf, req, csrfCookie } : null;
}

// Gate 4: the consent CSP cannot block the form's redirect chain. Polls, because
// a single fetch can read the pre-deploy header and pass falsely.
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
    record("4 consent CSP permits the chain", COULD_NOT_RUN, `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`);
    return;
  }
  // The consent form's redirect chain terminates at a dynamically registered client
  // redirect_uri, so no static form-action allowlist can be correct. Absent is required;
  // present is a fail regardless of value.
  const passed = !csp || !/form-action/i.test(csp);
  record("4 consent CSP permits the chain", passed, passed ? `polls=${attempt} csp=${csp ?? "(none)"}` : `polls=${attempt} form-action present after ${POLL_ATTEMPTS} polls: ${csp}`);
}

// Gate 6: security headers, asserted per route class rather than per path.
//
// test/headers.test.ts proves the header function is right; only a live request proves
// every response reaches it. workers-oauth-provider generates /token, /register and both
// .well-known documents itself, outside src/, which is why those are listed.
//
// Two more checks ride the same loop:
//
//   - The consent page and the authorization-server metadata must carry no-store.
//   - The CSP report sink must answer 204 to a synthetic report: a browser posts a report
//     once and never retries, so a broken sink is otherwise invisible.
//
// Polls, because a single fetch after a deploy reads the previous version.
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
    ["/authorize consent", "html", { url: consent, init: { redirect: "manual" }, noStore: true }],
    ["/authorize bad req", "other", { url: `${ORIGIN}/authorize`, init: { redirect: "manual" } }],
    ["/callback no code", "other", { url: `${ORIGIN}/callback`, init: { redirect: "manual" } }],
    [".well-known/as", "json", { url: `${ORIGIN}/.well-known/oauth-authorization-server`, noStore: true }],
    [".well-known/prm", "json", { url: `${ORIGIN}/.well-known/oauth-protected-resource` }],
    ["/mcp 401", "any", { url: `${ORIGIN}/mcp`, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } }],
    ["/ops/mcp 401", "other", { url: `${ORIGIN}/ops/mcp`, init: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } }],
    ["/ops/backup 401", "other", { url: `${ORIGIN}/ops/backup`, init: { method: "POST" } }],
    ["/nope 404", "other", { url: `${ORIGIN}/nope` }],
    ["/csp-report", "other", { url: `${ORIGIN}/csp-report`, init: { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: report }, status: 204 }],
  ];

  let problems = [];
  let attempt = 0;
  let lost = null;
  for (attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    problems = [];
    lost = null;
    for (const [label, cls, { url, init, noStore, status }] of surfaces) {
      let resp;
      try {
        resp = await request(url, { ...(init ?? {}), headers: { "Cache-Control": "no-cache", ...((init ?? {}).headers ?? {}) } });
      } catch (err) {
        lost = noAnswer(err);
        break;
      }
      const h = (name) => resp.headers.get(name);

      if (status && resp.status !== status) problems.push(`${label}: status ${resp.status}, expected ${status}`);
      if (noStore && !/no-store/i.test(h("cache-control") ?? "")) problems.push(`${label}: cache-control ${h("cache-control") ?? "(none)"}, expected no-store`);

      // Every class, no exception.
      if (!h("strict-transport-security")) problems.push(`${label}: no HSTS`);
      if (!h("x-content-type-options")) problems.push(`${label}: no nosniff`);

      const isHtml = (h("content-type") ?? "").toLowerCase().includes("text/html");
      if (cls === "html" && !isHtml) problems.push(`${label}: expected html, got ${h("content-type")}`);

      if (isHtml) {
        if (!h("referrer-policy")) problems.push(`${label}: no Referrer-Policy`);
        if (!h("x-frame-options")) problems.push(`${label}: no X-Frame-Options`);
        if (!h("permissions-policy")) problems.push(`${label}: no Permissions-Policy`);
        // The enforced CSP the consent dialog sets for itself must survive the
        // header layer untouched.
        if (!h("content-security-policy")) problems.push(`${label}: lost its enforced CSP`);
        // On trial, not enforced.
        if (!h("cross-origin-opener-policy-report-only")) problems.push(`${label}: no COOP-Report-Only`);
      } else {
        if (!h("content-security-policy-report-only")) problems.push(`${label}: no CSP-Report-Only`);
      }
    }
    if (!lost && problems.length === 0) break;
    if (attempt < POLL_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  if (lost) {
    record("6 security headers per class", COULD_NOT_RUN, `polls=${POLL_ATTEMPTS}, the last without an answer: ${lost.message}`);
    return;
  }
  record(
    "6 security headers per class",
    problems.length === 0,
    problems.length === 0
      ? `polls=${attempt} ${surfaces.length} surfaces clean`
      : `polls=${attempt} ${problems.length} problems: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? " ..." : ""}`
  );
}

// Gate 5: approving the form redirects to GitHub's authorize endpoint. This is
// where the run stops. It never follows the 302 and never touches GitHub.
async function gateGithubRedirect(clientId, form) {
  const body = new URLSearchParams({ csrf: form.csrf, req: form.req });
  let resp;
  try {
    // Safe to retry: the csrf check compares the field with the cookie and consumes
    // nothing (src/routes.ts), so a repeat POST is judged the same way as the first.
    resp = await request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `capsid_csrf=${form.csrfCookie}` },
      body: body.toString(),
      redirect: "manual",
    });
  } catch (err) {
    record("5 approve redirects to GitHub", COULD_NOT_RUN, noAnswer(err).message);
    return;
  }
  const location = resp.headers.get("location") ?? "";
  const passed = resp.status === 302 && location.startsWith("https://github.com/login/oauth/authorize");
  const shown = passed ? new URL(location).origin + new URL(location).pathname : location || "(none)";
  record("5 approve redirects to GitHub", passed, `status=${resp.status} location=${shown} (not followed)`);
}

const clientId = await (async () => {
  await gateHealth();
  await gateBackupFreshness();
  await gateCanary();
  return gateRegister();
})();

// Whether a skipped gate is a refusal or could-not-run follows the gate it depends on.
const upstream = (gate) => (results.find((r) => r.gate === gate)?.passed === COULD_NOT_RUN ? COULD_NOT_RUN : false);

if (clientId) {
  const form = await gateConsentForm(clientId);
  await gateCsp(clientId);
  await gateSecurityHeaders(clientId);
  if (form && form !== COULD_NOT_RUN) await gateGithubRedirect(clientId, form);
  else record("5 approve redirects to GitHub", upstream("3 consent form renders"), "skipped: gate 3 did not yield a usable form");
} else {
  record("3 consent form renders", upstream("2 register (fresh client)"), "skipped: no client id from gate 2");
}

// process.exitCode rather than process.exit(): exiting with fetch sockets still closing
// trips a libuv assertion on Windows and replaces the exit code with 3221226505.
const failed = results.filter((r) => r.passed === false);
const norun = results.filter((r) => r.passed === COULD_NOT_RUN);
console.log(`\n${results.length - failed.length - norun.length}/${results.length} gates passed against ${ORIGIN}`);
if (failed.length) {
  console.log(`FAILED GATES: ${failed.map((f) => f.gate).join(", ")}`);
  if (norun.length) console.log(`COULD NOT RUN: ${norun.map((f) => f.gate).join(", ")}`);
  process.exitCode = EXIT_REFUSED;
} else if (norun.length) {
  console.log(`COULD NOT RUN: ${norun.map((f) => f.gate).join(", ")}. No gate refused this deploy; exiting ${EXIT_COULD_NOT_RUN} so it is not rolled back.`);
  process.exitCode = EXIT_COULD_NOT_RUN;
}
