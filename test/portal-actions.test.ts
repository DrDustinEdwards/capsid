import assert from "node:assert/strict";
import { test } from "node:test";
import { hmacHex } from "../src/auth.ts";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { b64urlDecode, b64urlEncode } from "../src/encoding.ts";
import { PORTAL_CSRF_COOKIE, type OpsFeedData } from "../src/ops-feed.ts";
import type { OpsSiteConfig } from "../src/ops-types/sites.ts";
import type { PortalPerformed, PortalPreview } from "../src/ops-types/portal.ts";
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
import { PORTAL_ACTIONS } from "../src/controls.ts";
import { handlePortalClaims, PORTAL_CLAIMS_PATH } from "../src/portal-claims.ts";
import { handlePortalStale, PORTAL_STALE_PATH } from "../src/portal-stale.ts";
import { handlePortalLibrary, PORTAL_LIBRARY_PATH } from "../src/portal-library.ts";
import { handlePortalTrends, PORTAL_TRENDS_PATH } from "../src/portal-trends.ts";
import { handlePortalDigest, handlePortalPlan, PORTAL_DIGEST_PATH, PORTAL_PLAN_PATH } from "../src/portal-overnight.ts";
import { handlePortalMaintenance, PORTAL_MAINTENANCE_PATH } from "../src/portal-maintenance.ts";
import { handlePortalConvergence, PORTAL_CONVERGENCE_PATH } from "../src/portal-convergence.ts";
import { fakeD1, fakeKv, type FakeD1, type FakeKv } from "./fakes.ts";
import { AWAITING_SEAT_KEY } from "../src/auto-merge-tick.ts";
import { AUTO_MERGE_POLICY_PATH } from "../src/auto-merge-policy.ts";
import { SUSPENDED_KEY } from "../src/merge-units.ts";
import { PAUSED_KEY } from "../src/merge-safety.ts";
import { policyPin, policyPinKey, signTaskBody } from "../src/signed-docs.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// approve_pr reads the pull request's head from GitHub at preview and at perform. Only
// that read is answered; nothing in this file reaches GitHub otherwise.
const APPROVED_HEAD = "a".repeat(40);
const passThrough = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://api.github.com/repos/owner/repo/pulls/41") return Response.json({ head: { sha: APPROVED_HEAD }, state: "open", merged: false });
  // sign_policy_from_repo reads docs/policy/auto-merge.md: the shipped policy, a version on.
  if (url === "https://api.github.com/repos/owner/repo/contents/docs/policy/auto-merge.md") {
    const text = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8").replace(/^- version: (\d+)$/m, (_, v: string) => `- version: ${Number(v) + 1}`);
    return Response.json({ type: "file", encoding: "base64", content: Buffer.from(text, "utf8").toString("base64"), size: text.length, sha: "f".repeat(40) });
  }
  return passThrough(input, init);
}) as typeof fetch;

// The Portal's controls (src/portal-actions.ts): a preview that writes nothing and
// signs what it previewed, then a perform that carries only that token. The job
// transitions themselves are driven through the Worker against real D1 in
// test-integration/portal-actions.test.ts; these cover the checks in front of them.

const SECRET = "portal-test-cookie-secret";
const CSRF = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const EMAIL = "admin@example.com";
const ACTOR = `access:${EMAIL}`;
const LATER = (ms: number) => new Date(NOW.getTime() + ms);

const DRIVER_SCOPES = JSON.stringify({ namespaces: ["capsid"], repos: "*", tools: "*", grants: ["read", "write"], flags: {} });

// The site configuration the previews read. The fake D1 does not model ops_sites, so
// its reads are answered here; the writes are performed against real D1 in
// test-integration/portal-actions.test.ts and test-integration/ops-sites.test.ts.
const SITE_ROWS: OpsSiteConfig[] = [
  { namespace: "capsid", name: "Capsid", origin: "https://capsid.example.com", health_path: "/health", platform: "cloudflare", script: "capsid", self_probe: true, revision: 3, updated_at: "2026-09-28 00:00:00", operator: null, operator_problem: null },
  // A site that opted into Capsid calling its operator API (migrations/0035).
  {
    namespace: "sample",
    name: "Sample",
    origin: "https://sample.example.com",
    health_path: "/api/health",
    platform: "cloudflare",
    script: null,
    self_probe: false,
    revision: 1,
    updated_at: "2026-09-28 00:00:00",
    operator: { path: "/api/operator", auth_var: "SAMPLE_OPERATOR_TOKEN", repairs: { "content-drift": "sync_posts" }, weekly: ["refresh_citations"], secrets: [] },
    operator_problem: null,
  },
];

// The package configuration, answered the same way (ops_packages).
const PACKAGE_ROWS = [{ name: "sample-pkg", registry: "npm", repo: "example-org/sample-pkg", formerly: null, revision: 1, updated_at: "2026-09-28 00:00:00" }];

// One pending canon proposal, answered the same way (canon_proposals). It creates a
// document the fake does not hold, so its base is null and it can be approved. The
// approve and reject themselves run against real D1 in test-integration/canon.test.ts.
const CANON_ROWS = [
  {
    id: 7,
    namespace: "capsid",
    path: "core.md",
    title: "sample - core",
    body: "# sample\n\nThe sample service answers on port 8080.\n- Agents must call write after every job.",
    type: null,
    tags: null,
    status: null,
    mode: "replace",
    base_sha: null,
    proposer: "agent:capsid-driver",
    created_at: "2026-09-28T11:00:00.000Z",
    directive_lines: JSON.stringify(["- Agents must call write after every job."]),
    state: "pending",
    decided_by: null,
    decided_at: null,
    decided_reason: null,
  },
];

function withSites(db: D1Database, sites: OpsSiteConfig[]): D1Database {
  const toRow = (s: OpsSiteConfig) => ({ ...s, self_probe: s.self_probe ? 1 : 0, operator: s.operator ? JSON.stringify(s.operator) : null });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        // The approval record (migrations/0037): no open approval.
        if (/FROM pr_approvals/i.test(sql)) {
          const statement = {
            bind: () => statement,
            all: async () => ({ results: [], meta: {} }),
          };
          return statement;
        }
        if (/FROM canon_proposals/i.test(sql)) {
          const statement = {
            params: [] as unknown[],
            bind(...params: unknown[]) {
              statement.params = params;
              return statement;
            },
            async first() {
              return CANON_ROWS.find((p) => p.id === statement.params[0]) ?? null;
            },
            // pendingProposals' read, joined to a document the fake does not hold.
            async all() {
              return { results: CANON_ROWS.filter((p) => p.state === "pending").map((p) => ({ ...p, doc_id: null, current_body: null })), meta: {} };
            },
          };
          return statement;
        }
        if (/FROM ops_packages/i.test(sql)) {
          const statement = {
            params: [] as unknown[],
            bind(...params: unknown[]) {
              statement.params = params;
              return statement;
            },
            async first() {
              return PACKAGE_ROWS.find((p) => p.name === statement.params[0]) ?? null;
            },
            async all() {
              return { results: PACKAGE_ROWS, meta: {} };
            },
          };
          return statement;
        }
        if (!/FROM ops_sites/i.test(sql)) return target.prepare(sql);
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async first() {
            const [ns] = statement.params;
            const hit = sites.find((s) => s.namespace === ns);
            return hit ? toRow(hit) : null;
          },
          async all() {
            return { results: sites.map(toRow), meta: {} };
          },
        };
        return statement;
      };
    },
  });
}

// The signed auto-merge policy, as shipped (docs/policy/auto-merge.md, version 8), for
// sign_policy_change: signed with the world's key, so it loads as the Worker's copy does.
const POLICY_BODY = readFileSync(join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"), "utf8");
const SIGNED_POLICY = await signTaskBody("portal-test-signing-secret", POLICY_BODY);
// Its anti-rollback pin, as a Worker that has loaded the policy before holds it.
const POLICY_PIN = JSON.stringify(await policyPin(POLICY_BODY));

function world(opts: { adminEmail?: string; coOwners?: string } = {}): { d1: FakeD1; kv: FakeKv; env: never } {
  const d1 = fakeD1({
    documents: [{ namespace: "capsid", path: AUTO_MERGE_POLICY_PATH, title: "Auto-merge policy", body: SIGNED_POLICY }],
    namespaces: [
      { namespace: "capsid", repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) },
      { namespace: "capsid-new", repos: JSON.stringify([{ repo: "owner/new", label: "primary" }]) },
    ],
    agents: [
      {
        id: "agent_driver000001",
        name: "capsid-driver",
        kind: "driver",
        key_hash: "f".repeat(64),
        scopes: DRIVER_SCOPES,
        created_by: "github:sample",
        created_at: "2026-09-01 00:00:00",
        revoked_at: null,
        last_seen: null,
      },
    ],
    jobs: [
      { id: "job_blocked00001", namespace: "capsid", title: "a blocked job", body: "lorem", status: "blocked", posted_by: "github:sample", claimed_by: "agent:capsid-driver" },
      {
        id: "job_claimed00001",
        namespace: "capsid",
        title: "a claimed job",
        body: "lorem",
        status: "claimed",
        posted_by: "github:sample",
        claimed_by: "agent:capsid-other",
        lease_expires: "2026-09-28T13:00:00.000Z",
      },
      { id: "job_queued000001", namespace: "capsid", title: "a queued job", body: "lorem", status: "queued", posted_by: "github:sample" },
      { id: "job_parked000001", namespace: "capsid", title: "a parked job", body: "lorem", status: "parked", posted_by: "github:sample", result_summary: "comes back when the design is ruled" },
    ],
  });
  // A pull request the tick classed approve, for approve_pr, and the App's token for its repo.
  const kv = fakeKv({
    seed: {
      [AWAITING_SEAT_KEY]: JSON.stringify([{ namespace: "capsid", repo: "owner/repo", number: 41, failed: "path_class", why: "a src change", at: NOW.toISOString(), class: "approve", path_class: "src-routine", class_reasons: [] }]),
      "gh:token:v3:owner/repo": "test-token",
      [policyPinKey(AUTO_MERGE_POLICY_PATH)]: POLICY_PIN,
      // A merge unit a rollback suspended (src/merge-units.ts), for unit_resume.
      [SUSPENDED_KEY]: JSON.stringify([{ unit: "capsid/docs", since: "2026-09-27T00:00:00.000Z", reason: "owner/repo#40 merged unattended and was rolled back" }]),
      // A namespace the safety shutoff paused (src/merge-safety.ts), for automerge_resume.
      [PAUSED_KEY]: JSON.stringify({ capsid: { since: "2026-09-27T00:00:00.000Z", reason: "2 of the pull requests auto-merge merged were rolled back or reverted in 7 days" } }),
    },
  });
  const env = {
    DB: withSites(d1.db, SITE_ROWS),
    APP_KV: kv.kv,
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    IMPROVE_SCORE_SECRET: "portal-test-signing-secret",
    ADMIN_EMAIL: opts.adminEmail ?? EMAIL,
    ...(opts.coOwners === undefined ? {} : { CO_OWNER_EMAILS: opts.coOwners }),
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
    SAMPLE_OPERATOR_TOKEN: "sample-operator-token-for-tests-only-0000",
  } as never;
  return { d1, kv, env };
}

interface Opts {
  csrfHeader?: string | null;
  csrfCookie?: string | null;
  session?: string | false;
  auth?: string;
  site?: string | null;
  raw?: string;
}

async function post(path: string, body: unknown, opts: Opts = {}): Promise<Request> {
  const cookies: string[] = [];
  if (opts.session !== false) cookies.push((await portalSessionCookie({ email: opts.session ?? EMAIL }, SECRET, NOW)).split(";")[0]);
  const cookie = opts.csrfCookie === undefined ? CSRF : opts.csrfCookie;
  if (cookie) cookies.push(`${PORTAL_CSRF_COOKIE}=${cookie}`);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  const header = opts.csrfHeader === undefined ? CSRF : opts.csrfHeader;
  if (header) headers[PORTAL_CSRF_HEADER] = header;
  const site = opts.site === undefined ? "same-origin" : opts.site;
  if (site) headers["Sec-Fetch-Site"] = site;
  if (opts.auth) headers.Authorization = opts.auth;
  return new Request(`https://capsid.example${path}`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
}

const preview = (body: unknown, opts?: Opts) => post(PORTAL_PREVIEW_PATH, body, opts);
const perform = (body: unknown, opts?: Opts) => post(PORTAL_PERFORM_PATH, body, opts);

// The feed a perform returns, in place of the live read.
const FEED: OpsFeedData = {
  snapshot: null,
  scheduled: { tasks: [], error: null },
  live: {
    generated: NOW.toISOString(),
    store: { size_bytes: null, cap_bytes: 10 * 1024 ** 3 },
    inbox: { generated: NOW.toISOString(), count: 0, severity: "none", apps: [] },
    canon_proposals: [],
    findings: [],
    jobs: [],
    agents: [],
    prs: [],
    awaiting_seat: [],
    merge_safety: null,
    merge_policy: { loads: false, reason: "sample" },
    overnight: { mode: "off", decision: null },
    sessions: [],
    namespaces: [],
    sites: [],
    packages: [],
  },
  refresh_allowed_at: null,
  cloudflare_configured: false,
};
const deps = { feed: async () => FEED };

function wroteNothing(w: { d1: FakeD1; kv: FakeKv }, label: string) {
  assert.deepEqual(w.d1.recorded, [], `${label} wrote to D1`);
  assert.deepEqual(w.kv.puts, [], `${label} put to KV`);
  assert.deepEqual(w.kv.deleted, [], `${label} deleted from KV`);
}

// A perform that the control itself refuses has spent its confirmation (the nonce) and changed nothing else.
function spentOnly(w: { d1: FakeD1; kv: FakeKv }, label: string) {
  assert.deepEqual(w.d1.recorded, [], `${label} wrote to D1`);
  assert.ok(w.kv.puts.length > 0 && w.kv.puts.every((p) => p.key.startsWith("control-nonce:")), `${label} put something to KV besides its spent confirmation`);
  assert.deepEqual(w.kv.deleted, [], `${label} deleted from KV`);
}

async function previewOk(w: { env: never }, action: string, params: Record<string, string>): Promise<PortalPreview> {
  const res = await handlePortalPreview(await preview({ action, params }), w.env, NOW);
  assert.equal(res.status, 200, `${action} preview: ${await res.clone().text()}`);
  return (await res.json()) as PortalPreview;
}

// The token's payload, decoded, edited and re-encoded with the original signature.
function tamper(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [payload, sig] = token.split(".");
  const claims = JSON.parse(b64urlDecode(payload)) as Record<string, unknown>;
  edit(claims);
  return `${b64urlEncode(JSON.stringify(claims))}.${sig}`;
}

// A token signed the way the Worker signs one, for claims no preview would issue.
async function forge(claims: Record<string, unknown>): Promise<string> {
  const payload = b64urlEncode(JSON.stringify(claims));
  return `${payload}.${await hmacHex(await hmacHex(SECRET, "capsid-portal-confirm:v2"), payload)}`;
}

// The absences

test("PLANT: a merge or a mint is refused at preview and at perform, even fully signed, and writes nothing", async () => {
  for (const action of ["merge", "manage_pr", "mint", "mint_operator_key", "mint_agent"]) {
    assert.ok(!(PORTAL_ACTIONS as readonly string[]).includes(action), `PORTAL_ACTIONS includes ${action}`);
    const w = world();
    const res = await handlePortalPreview(await preview({ action, params: {} }), w.env, NOW);
    assert.equal(res.status, 400, `${action} was not refused as an unknown action`);
    assert.match(await res.text(), /deliberately not among them/);
    wroteNothing(w, `${action} preview`);

    const token = await forge({ v: 2, jti: "a".repeat(32), action, params: {}, email: EMAIL, exp: NOW.getTime() / 1000 + 60 });
    const performed = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
    assert.equal(performed.status, 400, `a signed ${action} token was performed`);
    wroteNothing(w, `${action} perform`);
  }
});

const EVERY_ACTION = [
  ["overnight", { value: "api", reason: "first supervised night" }],
  ["resume_job", { id: "job_blocked00001", reason: "ran the push" }],
  ["release_job", { id: "job_claimed00001", reason: "the holder is gone" }],
  ["fail_job", { id: "job_queued000001", reason: "superseded" }],
  ["close_shipped", { id: "job_blocked00001", reason: "merged and live" }],
  ["supersede_job", { id: "job_queued000001", reason: "a duplicate of job_claimed00001" }],
  ["park_job", { id: "job_queued000001", reason: "comes back when the design is ruled" }],
  ["unpark_job", { id: "job_parked000001" }],
  ["pr_close", { namespace: "capsid", number: "41", reason: "replaced by #42" }],
  ["approve_pr", { namespace: "capsid", prs: "41", shas: "a".repeat(40) }],
  ["revoke_agent", { name: "capsid-driver" }],
  ["site_add", { namespace: "capsid-new", origin: "https://new.example.com", platform: "cloudflare" }],
  ["site_edit", { namespace: "capsid", revision: "3", name: "Capsid", origin: "https://capsid.example.com", health_path: "/healthz", platform: "cloudflare", script: "capsid" }],
  ["site_remove", { namespace: "capsid", revision: "3" }],
  ["reset_breaker", { namespace: "capsid" }],
  ["package_add", { name: "sample-new", repo: "example-org/sample-new" }],
  ["package_edit", { name: "sample-pkg", revision: "1", repo: "example-org/sample-pkg", formerly: "sample-old" }],
  ["package_remove", { name: "sample-pkg", revision: "1" }],
  ["canon_approve", { id: "7" }],
  ["canon_reject", { id: "7", reason: "the rule belongs in a typed doc" }],
  ["canon_approve_all", {}],
  ["site_repair", { namespace: "sample", tool: "sync_posts" }],
  ["sign_policy_change", { change: "promote", unit: "capsid/tests", confirm: "9" }],
  ["sign_policy_from_repo", { confirm: "9" }],
  ["unit_resume", { unit: "capsid/docs", reason: "the rollback's cause is fixed" }],
  ["automerge_resume", { namespace: "capsid", reason: "both rollbacks are answered" }],
] as const;

test("the Portal's actions are the five job and agent actions the old /console page had, the overnight switch, the three site edits, the breaker reset, the three package edits, close as shipped, the two canon decisions and approve all, the site repair, supersede, park, unpark and PR close, and approve, the two merge resumes, and every loop below covers each", () => {
  // Written out, so an action added to PORTAL_ACTIONS without a decision here, or
  // without a row below, fails.
  assert.deepEqual([...PORTAL_ACTIONS].sort(), [
    "approve_pr",
    "automerge_resume",
    "canon_approve",
    "canon_approve_all",
    "canon_reject",
    "close_shipped",
    "fail_job",
    "overnight",
    "package_add",
    "package_edit",
    "package_remove",
    "park_job",
    "pr_close",
    "release_job",
    "reset_breaker",
    "resume_job",
    "revoke_agent",
    "sign_policy_change",
    "sign_policy_from_repo",
    "site_add",
    "site_edit",
    "site_remove",
    "site_repair",
    "supersede_job",
    "unit_resume",
    "unpark_job",
  ]);
  assert.deepEqual(EVERY_ACTION.map(([action]) => action).sort(), [...PORTAL_ACTIONS].sort());
  assert.equal(PORTAL_ACTIONS.length, 26);
});

// Every action: the CSRF pair, and a preview that writes nothing

for (const [action, params] of EVERY_ACTION) {
  for (const [label, opts] of [
    ["with no CSRF header", { csrfHeader: null }],
    ["when the CSRF header does not match the cookie", { csrfHeader: "ffffffff-2222-4333-8444-555555555555" }],
    ["when there is no CSRF cookie", { csrfCookie: null }],
  ] as const) {
    test(`PLANT: ${action} preview REFUSES ${label}, and writes nothing`, async () => {
      const w = world();
      const res = await handlePortalPreview(await preview({ action, params }, opts), w.env, NOW);
      assert.equal(res.status, 403, `${action} preview was served ${label}`);
      assert.match(await res.text(), /csrf validation failed/);
      wroteNothing(w, action);
    });
  }

  test(`PLANT: ${action} preview states what will change, signs it, and writes NOTHING`, async () => {
    const w = world();
    const body = await previewOk(w, action, params);
    assert.equal(body.action, action);
    assert.ok(body.summary.length > 20, "no summary");
    assert.ok(body.changes.length >= 1 && body.changes.every((c) => c.length > 10), `no concrete changes: ${JSON.stringify(body.changes)}`);
    assert.ok(body.audit.includes(`portal-${action} by ${ACTOR}`), `the click row is not in the preview's audit list: ${JSON.stringify(body.audit)}`);
    assert.equal(body.audit.length, 2, "the mutator's row and the click row");
    assert.match(body.token, /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    assert.equal(body.expires_at, LATER(5 * 60_000).toISOString());
    wroteNothing(w, `${action} preview`);
  });
}

// The concrete lines, where they name what the state holds now

test("an approve all preview lists each proposal and its flagged lines, and its token binds the plan it read", async () => {
  const body = await previewOk(world(), "canon_approve_all", { reason: "the rules audit" });
  assert.match(body.changes[0], /^1 pending canon proposal\(s\): 1 approved, 0 rejected/);
  assert.ok(body.changes.includes("instruction (proposal 7, capsid/core.md): - Agents must call write after every job."), JSON.stringify(body.changes));
  assert.ok(body.changes.some((c) => /^approve proposal 7 \(capsid\/core\.md, from agent:capsid-driver\): capsid\/core\.md is created; 3 line\(s\) added, 0 removed\.$/.test(c)), JSON.stringify(body.changes));
  assert.equal(body.changes.at(-1), `Your reason "the rules audit" is recorded in the portal-canon_approve_all audit row.`);
  const claims = JSON.parse(b64urlDecode(body.token.split(".")[0])) as { params: Record<string, string> };
  assert.deepEqual(claims.params, { reason: "the rules audit", plan: "7:approve" });
});

test("PLANT: approve all refuses a plan sent by the caller, and writes nothing", async () => {
  const w = world();
  const res = await handlePortalPreview(await preview({ action: "canon_approve_all", params: { plan: "7:approve" } }), w.env, NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /canon_approve_all takes reason; 'plan' is not one of them/);
  wroteNothing(w, "canon_approve_all with a plan");
});

test("a resume preview says the job goes back to its claimant, naming it", async () => {
  const body = await previewOk(world(), "resume_job", { id: "job_blocked00001", reason: "ran the push" });
  assert.match(body.changes[0], /blocked -> claimed by agent:capsid-driver/);
});

test("a resume preview says the job goes to the queue, and why, when its claimant is a shared identity", async () => {
  const w = world();
  w.d1.rows.jobs[0].claimed_by = "access:admin@example.com";
  const body = await previewOk(w, "resume_job", { id: "job_blocked00001", reason: "ran the push" });
  assert.match(body.changes[0], /blocked -> queued/);
  assert.match(body.changes[0], /access:admin@example.com is a shared identity/);
});

test("a resume preview no longer sends the job to the queue because its claimant holds another claim", async () => {
  const w = world();
  w.d1.rows.jobs.push({ ...w.d1.rows.jobs[1], id: "job_claimed00002", title: "another", claimed_by: "agent:capsid-driver" });
  const body = await previewOk(w, "resume_job", { id: "job_blocked00001", reason: "ran the push" });
  assert.match(body.changes[0], /blocked -> claimed by agent:capsid-driver/);
});

test("a revoke preview lists the jobs the agent holds", async () => {
  const body = await previewOk(world(), "revoke_agent", { name: "capsid-driver" });
  assert.match(body.changes[1], /holds 1 job/);
  assert.match(body.changes[1], /job_blocked00001 \(blocked/);
});

// Preview refusals against the current state

test("preview refuses what the mutator would refuse, and writes nothing", async () => {
  for (const [action, params, pattern] of [
    ["overnight", { value: "banana", reason: "x" }, /banana/],
    ["overnight", { value: "api" }, /needs a reason/],
    ["reset_breaker", { namespace: "nosuch" }, /not on the roster/],
    ["overnight", { value: "on", reason: "x" }, /overnight must be one of api, subscription, off/],
    ["resume_job", { id: "job_queued000001", reason: "x" }, /not blocked/],
    ["resume_job", { id: "job_blocked00001" }, /needs a reason/],
    ["resume_job", { id: "job_blocked00001", reason: "x", note: "n".repeat(16_385) }, /at most 16384 characters/],
    ["release_job", { id: "job_blocked00001", reason: "x" }, /not claimed/],
    ["close_shipped", { id: "job_claimed00001", reason: "x" }, /not blocked/],
    ["close_shipped", { id: "job_blocked00001" }, /needs a reason/],
    ["supersede_job", { id: "job_blocked00001", reason: "x" }, /a blocked job has hit a gate, so it is failed instead/],
    ["supersede_job", { id: "job_queued000001" }, /needs a reason/],
    ["supersede_job", { id: "job_queued000001", reason: "x", replaced_by: "job_queued000001" }, /cannot be replaced by itself/],
    ["park_job", { id: "job_claimed00001", reason: "later" }, /Park changes a queued job/],
    ["park_job", { id: "job_queued000001", reason: "two\nlines" }, /in one line/],
    ["unpark_job", { id: "job_queued000001" }, /not parked/],
    ["pr_close", { namespace: "capsid", number: "41" }, /needs a reason/],
    ["pr_close", { namespace: "capsid", number: "-1", reason: "x" }, /needs the pull request's number/],
    ["pr_close", { namespace: "nosuch", number: "41", reason: "x" }, /unknown namespace: nosuch/],
    ["fail_job", { id: "job_missing00001", reason: "x" }, /no job job_missing00001/],
    ["revoke_agent", { name: "ghost" }, /no agent named 'ghost'/],
    ["overnight", { value: "api", reason: "x", extra: "y" }, /'extra' is not one of them/],
  ] as const) {
    const w = world();
    const res = await handlePortalPreview(await preview({ action, params }), w.env, NOW);
    assert.equal(res.status, 400, `${action} ${JSON.stringify(params)} was not refused`);
    assert.match(await res.text(), pattern);
    wroteNothing(w, `${action} refused preview`);
  }
});

test("a revoked agent is refused at preview", async () => {
  const w = world();
  w.d1.rows.agents[0].revoked_at = "2026-09-20 00:00:00";
  const res = await handlePortalPreview(await preview({ action: "revoke_agent", params: { name: "capsid-driver" } }), w.env, NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already revoked/);
});

// The automation switches: a reason in both directions, and an Undo that says so

const SWITCH_CASES = [
  ["overnight", { value: "api" }],
  ["overnight", { value: "subscription" }],
] as const;

test("PLANT: overnight REFUSES a missing or blank reason at preview, and writes nothing", async () => {
  for (const [action, params] of SWITCH_CASES) {
    for (const reason of [undefined, "   "]) {
      const w = world();
      const res = await handlePortalPreview(await preview({ action, params: reason === undefined ? params : { ...params, reason } }), w.env, NOW);
      assert.equal(res.status, 400, `${action} previewed with reason ${JSON.stringify(reason)}`);
      assert.match(await res.text(), new RegExp(`^${action} needs a reason`));
      wroteNothing(w, `${action} with no reason`);
    }
  }
});

test("PLANT: a signed switch token with no reason (issued before the rule) is refused at perform and changes nothing", async () => {
  for (const [action, params] of SWITCH_CASES) {
    const w = world();
    const token = await forge({ v: 2, jti: "b".repeat(32), action, params, email: EMAIL, exp: NOW.getTime() / 1000 + 60 });
    const res = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
    assert.equal(res.status, 400, `${action} with no reason was performed`);
    assert.match(await res.text(), /needs a reason/);
    spentOnly(w, `${action} perform with no reason`);
  }
});

test("each switch's click row records its reason", async () => {
  for (const [action, params] of SWITCH_CASES) {
    const w = world();
    const reason = `because of ${action}`;
    const { token } = await previewOk(w, action, { ...params, reason });
    const res = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
    assert.equal(res.status, 200, await res.clone().text());
    const click = w.d1.recorded.find((r) => r.params[1] === `portal-${action}`);
    assert.ok(click, `${action} wrote no click row`);
    const detail = JSON.parse(String(click.params[4])) as Record<string, unknown>;
    assert.equal(detail.reason, reason);
    assert.equal(detail.undo, undefined, `a plain ${action} says it is an undo`);
  }
});

test("PLANT: a click row records the address the click came from, and null when there is none", async () => {
  for (const [action, params] of SWITCH_CASES) {
    for (const [header, recorded] of [["203.0.113.7", "203.0.113.7"], ["2001:db8::7", "2001:db8::7"], [null, null]] as const) {
      const w = world();
      const { token } = await previewOk(w, action, { ...params, reason: "from somewhere" });
      const req = await perform({ token });
      if (header) req.headers.set("CF-Connecting-IP", header);
      const res = await handlePortalPerform(req, w.env, NOW, deps);
      assert.equal(res.status, 200, await res.clone().text());
      const click = w.d1.recorded.find((r) => r.params[1] === `portal-${action}`);
      assert.ok(click, `${action} wrote no click row`);
      const detail = JSON.parse(String(click.params[4])) as Record<string, unknown>;
      assert.ok("source_address" in detail, `${action}'s click row has no source_address at all`);
      assert.equal(detail.source_address, recorded, `${action} with ${header}`);
    }
  }
});

test("PLANT: an Undo previews and writes portal-undo-<action>, its own row, never portal-<action>", async () => {
  for (const [action, params] of SWITCH_CASES) {
    const w = world();
    const reason = "Undo: a mistaken flip";
    const body = await previewOk(w, action, { ...params, reason, undo: "true" });
    assert.ok(body.audit.includes(`portal-undo-${action} by ${ACTOR}`), `${action}'s undo preview does not list its own row: ${JSON.stringify(body.audit)}`);
    assert.ok(!body.audit.includes(`portal-${action} by ${ACTOR}`), `${action}'s undo preview lists the plain click row`);
    assert.match(body.summary, /^Undo: /);
    wroteNothing(w, `${action} undo preview`);
    const res = await handlePortalPerform(await perform({ token: body.token }), w.env, NOW, deps);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(auditRows(w.d1).sort(), [...body.audit].sort());
    const click = w.d1.recorded.find((r) => r.params[1] === `portal-undo-${action}`);
    assert.equal(click?.params[0], ACTOR);
    const detail = JSON.parse(String(click?.params[4])) as Record<string, unknown>;
    assert.equal(detail.undo, true);
    assert.equal(detail.reason, reason);
  }
});

test("undo is refused on any other value, and on an action that is not a switch", async () => {
  const w = world();
  const bad = await handlePortalPreview(await preview({ action: "overnight", params: { value: "off", reason: "x", undo: "yes" } }), w.env, NOW);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /undo is "true" or absent/);
  const other = await handlePortalPreview(await preview({ action: "fail_job", params: { id: "job_queued000001", reason: "x", undo: "true" } }), w.env, NOW);
  assert.equal(other.status, 400);
  assert.match(await other.text(), /'undo' is not one of them/);
  wroteNothing(w, "a refused undo");
});

// Perform

// The audit rows a perform wrote, as "<action> by <actor>".
function auditRows(d1: FakeD1): string[] {
  return d1.recorded.filter((r) => /INSERT INTO audit_log/i.test(r.sql)).map((r) => `${r.params[1]} by ${r.params[0]}`);
}

// The action whose mutator writes KV and one audit row, and the revoke; the job
// transitions (close_shipped, supersede, park and unpark among them), the PR close, the approval, the site edits, the package edits and the
// canon decisions are performed against real D1 in test-integration/portal-actions.test.ts.
for (const [action, params] of EVERY_ACTION.filter(([a]) => !a.endsWith("_job") && a !== "close_shipped" && a !== "pr_close" && a !== "approve_pr" && !a.startsWith("site_") && !a.startsWith("package_") && !a.startsWith("canon_"))) {
  test(`${action} performed from its token writes the rows its preview listed, and returns the feed`, async () => {
    const w = world();
    const { token, audit } = await previewOk(w, action, params);
    const res = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as PortalPerformed;
    assert.equal(body.action, action);
    assert.equal(body.warning, null);
    assert.deepEqual(body.feed, { ...FEED, csrf: CSRF, user: { name: "admin", initials: "A" } }, "the feed does not carry the session's csrf");
    assert.deepEqual(auditRows(w.d1).sort(), [...audit].sort(), "the rows written are not the rows the preview listed");
  });
}

test("the click row names the administrator, and the mutator's row says what happened", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
  assert.equal(w.kv.store.get("overnight:mode"), "api");
  const click = w.d1.recorded.find((r) => r.params[1] === "portal-overnight");
  assert.equal(click?.params[0], ACTOR);
});

test("a co-owner's click is audited under her own verified email, never ADMIN_EMAIL", async () => {
  const w = world({ coOwners: " other@example.com , co@example.com " });
  const co = { session: "co@example.com" };
  const prev = await handlePortalPreview(await preview({ action: "overnight", params: { value: "api", reason: "first supervised night" } }, co), w.env, NOW);
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

test("a co-owner's session is refused when CO_OWNER_EMAILS is unset, and a confirmation previewed by the primary owner is refused to her", async () => {
  const none = world();
  const refused = await handlePortalPreview(await preview({ action: "overnight", params: { value: "api", reason: "r" } }, { session: "co@example.com" }), none.env, NOW);
  assert.equal(refused.status, 302, "an unadmitted session is sent to sign in");
  wroteNothing(none, "a co-owner with no CO_OWNER_EMAILS");
  const w = world({ coOwners: "co@example.com" });
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  const res = await handlePortalPerform(await perform({ token }, { session: "co@example.com" }), w.env, NOW, deps);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /another session/);
  wroteNothing(w, "a confirmation issued to the primary owner");
});

// A confirmation is used once (controls design, D2): the nonce makes a second perform a
// refusal of its own.
test("PLANT: a confirmation is spent by its first perform, and a replay is refused with 409 and writes nothing", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  const first = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
  assert.equal(first.status, 200, await first.clone().text());
  const before = w.d1.recorded.length;
  const second = await handlePortalPerform(await perform({ token }), w.env, LATER(4 * 60_000), deps);
  assert.equal(second.status, 409);
  assert.match(await second.text(), /already used/);
  assert.equal(w.d1.recorded.length, before, "a replayed confirmation wrote a row");
  assert.equal(auditRows(w.d1).filter((r) => r.startsWith("portal-overnight")).length, 1);
});

test("PLANT: an expired token is refused with 410 and nothing is performed", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  const res = await handlePortalPerform(await perform({ token }), w.env, LATER(5 * 60_000 + 1_000), deps);
  assert.equal(res.status, 410);
  assert.match(await res.text(), /expired: preview again/);
  wroteNothing(w, "an expired perform");
});

test("PLANT: a token whose params were edited is refused with 403", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  const edited = tamper(token, (c) => ((c.params as Record<string, string>).value = "subscription"));
  const res = await handlePortalPerform(await perform({ token: edited }), w.env, NOW, deps);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /does not verify/);
  wroteNothing(w, "a tampered perform");
});

test("PLANT: a token for one action cannot perform another", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  // Named in the body beside the token: refused, and the token's action does not run.
  const named = await handlePortalPerform(await perform({ token, action: "reset_breaker" }), w.env, NOW, deps);
  assert.equal(named.status, 400);
  // Written into the token itself: the signature no longer verifies.
  const edited = tamper(token, (c) => (c.action = "reset_breaker"));
  const signed = await handlePortalPerform(await perform({ token: edited }), w.env, NOW, deps);
  assert.equal(signed.status, 403);
  wroteNothing(w, "a cross-action perform");
});

test("PLANT: a perform body carrying params is refused, whatever the token", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  const res = await handlePortalPerform(await perform({ token, params: { value: "subscription", reason: "not what was previewed" } }), w.env, NOW, deps);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /only \{ token \}/);
  wroteNothing(w, "a perform with params");
});

test("a token issued to another session is refused with 403", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  // ADMIN_EMAIL changed between the preview and the perform, and the new administrator
  // signed in: a valid session, a valid signature, the wrong person.
  const other = world({ adminEmail: "other@example.com" });
  const res = await handlePortalPerform(await perform({ token }, { session: "other@example.com" }), other.env, NOW, deps);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /another session/);
  wroteNothing(other, "another session's perform");
});

test("a malformed token is refused with 403", async () => {
  for (const token of ["", "abc", "abc.def", `${"a".repeat(10)}.${"g".repeat(64)}`]) {
    const w = world();
    const res = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
    assert.equal(res.status, 403, `token '${token}'`);
    wroteNothing(w, "a malformed perform");
  }
});

test("a mutator refusal at perform is a 400 with its refusal, and no click row", async () => {
  const w = world();
  const { token } = await previewOk(w, "revoke_agent", { name: "capsid-driver" });
  w.d1.rows.agents[0].revoked_at = "2026-09-28 11:59:00";
  const res = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no live agent named 'capsid-driver'/);
  assert.deepEqual(auditRows(w.d1), []);
});

test("an action that happened but whose click row failed returns 200 with the warning, in the body and a header", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
  const db = w.d1.db as unknown as { batch: (s: Array<{ params?: unknown[] }>) => Promise<unknown> };
  const batch = db.batch.bind(db);
  db.batch = async (statements) => {
    if (statements.some((s) => s.params?.[1] === "portal-overnight")) throw new Error("D1_ERROR: database is locked");
    return batch(statements);
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  let res: Response;
  try {
    res = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 200);
  const body = (await res.json()) as PortalPerformed;
  assert.match(body.warning ?? "", /overnight completed, but the Portal audit row naming access:admin@example.com was not written/);
  assert.match(res.headers.get("X-Capsid-Warning") ?? "", /overnight completed/);
  assert.equal(w.kv.store.get("overnight:mode"), "api", "the action itself did not happen");
  assert.equal(errors.length, 1);
});

// Fetch metadata, the body cap, the JSON

test("PLANT: Sec-Fetch-Site cross-site and same-site are refused on both POSTs; same-origin and absent pass", async () => {
  for (const site of ["cross-site", "same-site", "none"]) {
    const w = world();
    const res = await handlePortalPreview(await preview({ action: "overnight", params: { value: "api", reason: "first supervised night" } }, { site }), w.env, NOW);
    assert.equal(res.status, 403, `preview served Sec-Fetch-Site: ${site}`);
    const { token } = await previewOk(w, "overnight", { value: "api", reason: "first supervised night" });
    const performed = await handlePortalPerform(await perform({ token }, { site }), w.env, NOW, deps);
    assert.equal(performed.status, 403, `perform served Sec-Fetch-Site: ${site}`);
    wroteNothing(w, `Sec-Fetch-Site: ${site}`);
  }
  for (const site of ["same-origin", null]) {
    const w = world();
    const res = await handlePortalPreview(await preview({ action: "overnight", params: { value: "api", reason: "first supervised night" } }, { site }), w.env, NOW);
    assert.equal(res.status, 200, `preview refused Sec-Fetch-Site: ${site}`);
  }
});

test("a body over 64KB is refused with 413 before it is parsed", async () => {
  const w = world();
  const res = await handlePortalPreview(await preview(null, { raw: JSON.stringify({ action: "overnight", params: { value: "x".repeat(70_000) } }) }), w.env, NOW);
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

test("all fourteen routes refuse a bearer with 403 and send an anonymous caller to sign in", async () => {
  assert.equal(ROUTES.length, 14);
  for (const [path, method, handler] of ROUTES) {
    const session = (await portalSessionCookie({ email: EMAIL }, SECRET, NOW)).split(";")[0];
    const headers = { Cookie: `${session}; ${PORTAL_CSRF_COOKIE}=${CSRF}`, [PORTAL_CSRF_HEADER]: CSRF, "Sec-Fetch-Site": "same-origin" };
    const body = method === "POST" ? JSON.stringify({ action: "overnight", params: { value: "api", reason: "first supervised night" } }) : undefined;
    // A bearer beside a valid session and CSRF pair is still refused: the gate reads it first.
    const bearer = await handler(new Request(`https://capsid.example${path}`, { method, headers: { ...headers, Authorization: "Bearer capsid_x" }, body }), world().env);
    assert.equal(bearer.status, 403, `${path} served a bearer`);
    const anonymous = await handler(new Request(`https://capsid.example${path}`, { method, headers: { [PORTAL_CSRF_HEADER]: CSRF }, body }), world().env);
    assert.equal(anonymous.status, 302, `${path} did not send an anonymous caller to sign in`);
    assert.match(anonymous.headers.get("Location") ?? "", /sample\.cloudflareaccess\.com/);
  }
});

test("the digest route refuses a since that is not an ISO time with 400, before reading anything", async () => {
  const w = world();
  const session = (await portalSessionCookie({ email: EMAIL }, SECRET, NOW)).split(";")[0];
  const res = await handlePortalDigest(new Request(`https://capsid.example${PORTAL_DIGEST_PATH}?since=yesterday`, { headers: { Cookie: session, "Sec-Fetch-Site": "same-origin" } }), w.env, NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /since must be an ISO 8601 time/);
  wroteNothing(w, "a refused digest read");
});

// Sign out

// Node's Headers has getSetCookie; the Workers types this suite checks against do not.
function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

async function signOut(opts: Opts = {}): Promise<Request> {
  return post(PORTAL_SIGN_OUT_PATH, {}, opts);
}

test("sign out expires the session and CSRF cookies at Path=/portal, and writes nothing", async () => {
  const w = world();
  const res = await handlePortalSignOut(await signOut(), w.env, NOW);
  assert.equal(res.status, 204);
  const cookies = setCookies(res);
  assert.equal(cookies.length, 2, `expected the session and CSRF cookies, got: ${cookies.join(" | ")}`);
  const names = cookies.map((c) => c.split("=")[0]).sort();
  assert.deepEqual(names, ["capsid_portal", PORTAL_CSRF_COOKIE]);
  for (const c of cookies) {
    assert.match(c, /; Max-Age=0(;|$)/, `${c} does not expire the cookie`);
    assert.match(c, /; Path=\/portal(;|$)/, `${c} is not scoped to the Portal, so it would not clear the cookie the login set`);
    assert.match(c, /HttpOnly; Secure; SameSite=Lax/);
  }
  wroteNothing(w, "sign out");
});

for (const [label, opts] of [
  ["with no CSRF header", { csrfHeader: null }],
  ["when the CSRF header does not match the cookie", { csrfHeader: "ffffffff-2222-4333-8444-555555555555" }],
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

test("an unknown path under /portal/api/ is a JSON 404 for the administrator, never the app's page", async () => {
  const w = world();
  const session = (await portalSessionCookie({ email: EMAIL }, SECRET, NOW)).split(";")[0];
  const res = await handlePortalApiNotFound(new Request("https://capsid.example/portal/api/typo", { headers: { Cookie: session } }), w.env, NOW);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("Content-Type") ?? "", /json/);
  assert.match(await res.text(), /no Portal route at GET \/portal\/api\/typo/);
});

// The overnight run's switch (src/overnight.ts)

test("PLANT: choosing the subscription previews and records Dustin's decision, its date and its reasoning; the API key records none", async () => {
  const sub = await previewOk(world(), "overnight", { value: "subscription", reason: "first supervised night" });
  const text = sub.changes.join("\n");
  assert.match(text, /decision of Dustin Edwards on 2026-10-04/);
  assert.match(text, /overnight runs may use the subscription, by Dustin's choice/);
  assert.match(text, /personal, on Dustin's own repositories, and not shared/);
  assert.match(text, /Hand-started VS Code tabs are unaffected/);
  const api = await previewOk(world(), "overnight", { value: "api", reason: "first supervised night" });
  assert.doesNotMatch(api.changes.join("\n"), /decision of Dustin/);
  assert.match(api.changes.join("\n"), /ANTHROPIC_API_KEY/);
});

test("PLANT: performing the subscription choice stores the mode and the decision record with the date, who set it and why; leaving it deletes the record", async () => {
  const w = world();
  const { token } = await previewOk(w, "overnight", { value: "subscription", reason: "first supervised night" });
  const done = await handlePortalPerform(await perform({ token }), w.env, NOW, deps);
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(await w.kv.kv.get("overnight:mode"), "subscription");
  const decision = JSON.parse((await w.kv.kv.get("overnight:decision")) ?? "null");
  assert.equal(decision.decided_by, "Dustin Edwards");
  assert.equal(decision.decided_on, "2026-10-04");
  assert.match(decision.ruling, /^2026-10-04: overnight runs may use the subscription/);
  assert.match(decision.reasoning, /not shared/);
  assert.equal(decision.set_by, ACTOR);
  assert.equal(decision.set_at, NOW.toISOString());
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
