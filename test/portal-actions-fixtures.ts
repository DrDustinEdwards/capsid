import { SHIPPED_VERSION } from "./policy-version.ts";
import assert from "node:assert/strict";
import {} from "node:test";
import { mintConfirm } from "@dustinedwards/site-runtime/confirm-token";
import { confirmKeys } from "../src/auth.ts";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { PORTAL_CSRF_COOKIE } from "../src/ops-feed.ts";
import type { OpsSiteConfig } from "../src/ops-types/sites.ts";
import type { PortalPreview } from "../src/ops-types/portal.ts";
import {
  handlePortalPerform,
  handlePortalPreview,
  PORTAL_CSRF_HEADER,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
} from "../src/portal-actions.ts";
import { FEED, fakeD1, fakeKv, type FakeD1, type FakeKv, withPortalSessionEnds } from "./fakes.ts";
import { AWAITING_SEAT_KEY } from "../src/auto-merge-tick.ts";
import { AUTO_MERGE_POLICY_PATH } from "../src/auto-merge-policy.ts";
import { SUSPENDED_KEY } from "../src/merge-units.ts";
import { PAUSED_KEY } from "../src/merge-safety.ts";
import { policyPin, policyPinKey, signTaskBody } from "../src/signed-docs.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBase64urlText } from "@dustinedwards/site-runtime/encoding";

// approve_pr reads the pull request's head from GitHub at preview and at perform. Only
// that read is answered; nothing in this file reaches GitHub otherwise.
const APPROVED_HEAD = "a".repeat(40);
const passThrough = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://api.github.com/repos/owner/repo/pulls/41")
    return Response.json({ head: { sha: APPROVED_HEAD }, state: "open", merged: false });
  // sign_policy_from_repo reads docs/policy/auto-merge.md: the shipped policy, a version on.
  if (url === "https://api.github.com/repos/owner/repo/contents/docs/policy/auto-merge.md") {
    const text = readFileSync(
      join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"),
      "utf8",
    ).replace(/^- version: (\d+)$/m, (_, v: string) => `- version: ${Number(v) + 1}`);
    return Response.json({
      type: "file",
      encoding: "base64",
      content: Buffer.from(text, "utf8").toString("base64"),
      size: text.length,
      sha: "f".repeat(40),
    });
  }
  return passThrough(input, init);
}) as typeof fetch;

export const SECRET = "portal-test-cookie-secret";
export const CSRF = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const NOW = new Date("2026-09-28T12:00:00.000Z");
export const EMAIL = "admin@example.com";
export const ACTOR = `access:${EMAIL}`;
export const LATER = (ms: number) => new Date(NOW.getTime() + ms);

const DRIVER_SCOPES = JSON.stringify({
  namespaces: ["capsid"],
  repos: "*",
  tools: "*",
  grants: ["read", "write"],
  flags: {},
});

// ops_sites and ops_packages, which the fake D1 does not model, are answered here from
// these rows; pr_approvals answers with no open approval. The writes run against real D1
// in test-integration/portal-actions.test.ts and test-integration/ops-sites.test.ts.
export const site = (over: Partial<OpsSiteConfig>): OpsSiteConfig =>
  ({
    script: null,
    self_probe: false,
    revision: 1,
    updated_at: "2026-09-28 00:00:00",
    operator: null,
    operator_problem: null,
    platform: "cloudflare",
    ...over,
  }) as OpsSiteConfig;
const SITE_ROWS = [
  site({
    namespace: "capsid",
    name: "Capsid",
    origin: "https://capsid.example.com",
    health_path: "/health",
    script: "capsid",
    self_probe: true,
    revision: 3,
  }),
  // A site that opted into Capsid calling its operator API.
  site({
    namespace: "sample",
    name: "Sample",
    origin: "https://sample.example.com",
    health_path: "/api/health",
    operator: {
      path: "/api/operator",
      auth_var: "SAMPLE_OPERATOR_TOKEN",
      repairs: { "content-drift": "sync_posts" },
      weekly: ["refresh_citations"],
      secrets: [],
      backup: true,
    },
  }),
];
const PACKAGE_ROWS = [
  {
    name: "sample-pkg",
    registry: "npm",
    repo: "example-org/sample-pkg",
    formerly: null,
    revision: 1,
    updated_at: "2026-09-28 00:00:00",
  },
];

function withSites(db: D1Database): D1Database {
  const sites = SITE_ROWS.map((s) => ({
    ...s,
    self_probe: s.self_probe ? 1 : 0,
    operator: s.operator ? JSON.stringify(s.operator) : null,
  }));
  const tables: Array<[RegExp, Array<Record<string, unknown>>, string]> = [
    [/FROM pr_approvals/i, [], ""],
    [/FROM ops_packages/i, PACKAGE_ROWS, "name"],
    [/FROM ops_sites/i, sites, "namespace"],
  ];
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const table = tables.find(([re]) => re.test(sql));
        if (!table) return target.prepare(sql);
        const [, rows, key] = table;
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          first: async () => rows.find((r) => r[key] === statement.params[0]) ?? null,
          all: async () => ({ results: rows, meta: {} }),
        };
        return statement;
      };
    },
  });
}

// The signed auto-merge policy, as shipped (docs/policy/auto-merge.md), for
// sign_policy_change: signed with the world's key, so it loads as the Worker's copy does.
const POLICY_BODY = readFileSync(
  join(import.meta.dirname, "..", "docs", "policy", "auto-merge.md"),
  "utf8",
);
const SIGNED_POLICY = await signTaskBody("portal-test-signing-secret", POLICY_BODY);
// Its anti-rollback pin, as a Worker that has loaded the policy before holds it.
const POLICY_PIN = JSON.stringify(await policyPin(POLICY_BODY));

export const agent = (id: string, name: string, hash: string, createdBy: string, day: string) => ({
  id,
  name,
  kind: "driver",
  key_hash: hash.repeat(64),
  scopes: DRIVER_SCOPES,
  created_by: createdBy,
  created_at: `${day} 00:00:00`,
  revoked_at: null,
  last_seen: null,
});
export const job = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  namespace: "capsid",
  title: `a ${status} job`,
  body: "lorem",
  status,
  posted_by: "github:sample",
  ...extra,
});

export function world(opts: { adminEmail?: string; coOwners?: string } = {}): {
  d1: FakeD1;
  kv: FakeKv;
  env: never;
} {
  const d1 = fakeD1({
    documents: [
      {
        namespace: "capsid",
        path: AUTO_MERGE_POLICY_PATH,
        title: "Auto-merge policy",
        body: SIGNED_POLICY,
      },
    ],
    namespaces: [
      { namespace: "capsid", repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) },
      { namespace: "capsid-new", repos: JSON.stringify([{ repo: "owner/new", label: "primary" }]) },
    ],
    agents: [
      agent("agent_driver000001", "capsid-driver", "f", "github:sample", "2026-09-01"),
      {
        ...agent(
          "agent_minted00001",
          "capsid-new-driver",
          "e",
          "access:admin@example.com",
          "2026-09-02",
        ),
        pending: 1,
      },
    ],
    jobs: [
      job("job_blocked00001", "blocked", { claimed_by: "agent:capsid-driver" }),
      job("job_claimed00001", "claimed", { claimed_by: "agent:capsid-other" }),
      job("job_queued000001", "queued"),
      job("job_parked000001", "parked", { result_summary: "comes back when the design is ruled" }),
    ],
  });
  // A pull request the tick classed approve, for approve_pr, and the App's token for its repo.
  const kv = fakeKv({
    seed: {
      [AWAITING_SEAT_KEY]: JSON.stringify([
        {
          namespace: "capsid",
          repo: "owner/repo",
          number: 41,
          failed: "path_class",
          why: "a src change",
          at: NOW.toISOString(),
          class: "approve",
          path_class: "src-routine",
          class_reasons: [],
        },
      ]),
      "gh:token:v3:owner/repo": "test-token",
      [policyPinKey(AUTO_MERGE_POLICY_PATH)]: POLICY_PIN,
      // A merge unit a rollback suspended (src/merge-units.ts), for unit_resume.
      [SUSPENDED_KEY]: JSON.stringify([
        {
          unit: "capsid/docs",
          since: "2026-09-27T00:00:00.000Z",
          reason: "owner/repo#40 merged unattended and was rolled back",
        },
      ]),
      // A namespace the safety shutoff paused (src/merge-safety.ts), for automerge_resume.
      [PAUSED_KEY]: JSON.stringify({
        capsid: {
          since: "2026-09-27T00:00:00.000Z",
          reason: "2 of the pull requests auto-merge merged were rolled back or reverted in 7 days",
        },
      }),
    },
  });
  const env = {
    DB: withPortalSessionEnds(withSites(d1.db)).db,
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
    // For site_key_rotate's preview: the token it would set the key with is set.
    CF_SECRETS_TOKEN: "sample-secrets-token",
    CF_ACCOUNT_ID: "sample-account",
  } as never;
  return { d1, kv, env };
}

export interface Opts {
  csrfHeader?: string | null;
  csrfCookie?: string | null;
  session?: string | false;
  auth?: string;
  site?: string | null;
  raw?: string;
}

export async function post(path: string, body: unknown, opts: Opts = {}): Promise<Request> {
  const cookies: string[] = [];
  if (opts.session !== false)
    cookies.push(
      (await portalSessionCookie({ email: opts.session ?? EMAIL }, SECRET, NOW)).split(";")[0],
    );
  const cookie = opts.csrfCookie === undefined ? CSRF : opts.csrfCookie;
  if (cookie) cookies.push(`__Secure-${PORTAL_CSRF_COOKIE}=${cookie}`);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  const header = opts.csrfHeader === undefined ? CSRF : opts.csrfHeader;
  if (header) headers[PORTAL_CSRF_HEADER] = header;
  const site = opts.site === undefined ? "same-origin" : opts.site;
  if (site) headers["Sec-Fetch-Site"] = site;
  if (opts.auth) headers.Authorization = opts.auth;
  return new Request(`https://capsid.example${path}`, {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

export const preview = (body: unknown, opts?: Opts) => post(PORTAL_PREVIEW_PATH, body, opts);
export const perform = (body: unknown, opts?: Opts) => post(PORTAL_PERFORM_PATH, body, opts);

export const deps = { feed: async () => FEED };

export function wroteNothing(w: { d1: FakeD1; kv: FakeKv }, label: string) {
  assert.deepEqual(w.d1.recorded, [], `${label} wrote to D1`);
  assert.deepEqual(w.kv.puts, [], `${label} put to KV`);
  assert.deepEqual(w.kv.deleted, [], `${label} deleted from KV`);
}

// A perform that the control itself refuses has spent its confirmation (the nonce) and changed nothing else.
export function spentOnly(w: { d1: FakeD1; kv: FakeKv }, label: string) {
  assert.deepEqual(w.d1.recorded, [], `${label} wrote to D1`);
  assert.ok(
    w.kv.puts.length > 0 && w.kv.puts.every((p) => p.key.startsWith("control-nonce:")),
    `${label} put something to KV besides its spent confirmation`,
  );
  assert.deepEqual(w.kv.deleted, [], `${label} deleted from KV`);
}

export async function previewOk(
  w: { env: never },
  action: string,
  params: Record<string, string>,
): Promise<PortalPreview> {
  const res = await handlePortalPreview(await preview({ action, params }), w.env, NOW);
  assert.equal(res.status, 200, `${action} preview: ${await res.clone().text()}`);
  return (await res.json()) as PortalPreview;
}

export const issue = (w: { env: never }) =>
  previewOk(w, "overnight", { value: "api", reason: "first supervised night" });

export const doPerform = async (w: { env: never }, token: string, opts?: Opts, now = NOW) =>
  handlePortalPerform(await perform({ token }, opts), w.env, now, deps);

// The token's payload, decoded, edited and re-encoded with the original signature.
export function tamper(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [payload, sig] = token.split(".");
  const signed = JSON.parse(fromBase64urlText(payload)) as { c: Record<string, unknown> };
  edit(signed.c);
  return `${Buffer.from(JSON.stringify(signed)).toString("base64url")}.${sig}`;
}

// A token signed the way the Worker signs one, for claims no preview would issue.
export async function forge(claims: Record<string, unknown>): Promise<string> {
  const keys = await confirmKeys({ COOKIE_ENCRYPTION_KEY: SECRET }, "capsid-portal-confirm:v2");
  return (await mintConfirm({ keys, claims, ttlSeconds: 60, now: NOW.getTime() })).token;
}

export const EVERY_ACTION = [
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
  ["activate_agent", { name: "capsid-new-driver" }],
  [
    "site_add",
    { namespace: "capsid-new", origin: "https://new.example.com", platform: "cloudflare" },
  ],
  [
    "site_edit",
    {
      namespace: "capsid",
      revision: "3",
      name: "Capsid",
      origin: "https://capsid.example.com",
      health_path: "/healthz",
      platform: "cloudflare",
      script: "capsid",
    },
  ],
  ["site_remove", { namespace: "capsid", revision: "3" }],
  ["reset_breaker", { namespace: "capsid" }],
  ["package_add", { name: "sample-new", repo: "example-org/sample-new" }],
  [
    "package_edit",
    { name: "sample-pkg", revision: "1", repo: "example-org/sample-pkg", formerly: "sample-old" },
  ],
  ["package_remove", { name: "sample-pkg", revision: "1" }],
  ["site_repair", { namespace: "sample", tool: "sync_posts" }],
  ["site_backup", {}],
  ["run_job", { namespace: "capsid", name: "supersede" }],
  [
    "sign_policy_change",
    { change: "promote", unit: "capsid/tests", confirm: `${SHIPPED_VERSION + 1}` },
  ],
  ["sign_policy_from_repo", { confirm: `${SHIPPED_VERSION + 1}` }],
  ["unit_resume", { unit: "capsid/docs", reason: "the rollback's cause is fixed" }],
  ["automerge_resume", { namespace: "capsid", reason: "both rollbacks are answered" }],
  ["namespace_add", { namespace: "sample-added", repo: "example-org/sample-added" }],
  [
    "namespace_edit",
    {
      namespace: "capsid-new",
      repos: JSON.stringify([{ repo: "example-org/new", label: "primary" }]),
    },
  ],
  ["namespace_remove", { namespace: "capsid-new" }],
  ["site_key_rotate", { namespace: "capsid" }],
] as const;

// The audit rows a perform wrote, as "<action> by <actor>".
export function auditRows(d1: FakeD1): string[] {
  return d1.recorded
    .filter((r) => /INSERT INTO audit_log/i.test(r.sql))
    .map((r) => `${r.params[1]} by ${r.params[0]}`);
}
