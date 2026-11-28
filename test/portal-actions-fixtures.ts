import assert from "node:assert/strict";
import { mintConfirm } from "@dustinedwards/site-runtime/confirm-token";
import { confirmKeys } from "../src/auth.ts";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { PORTAL_CSRF_COOKIE } from "../src/ops-feed.ts";
import type { PortalPreview } from "../src/ops-types/portal.ts";
import {
  handlePortalPerform,
  handlePortalPreview,
  PORTAL_CSRF_HEADER,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
} from "../src/portal-actions.ts";
import { FEED, fakeD1, fakeKv, type FakeD1, type FakeKv, withPortalSessionEnds } from "./fakes.ts";
import { fromBase64urlText } from "@dustinedwards/site-runtime/encoding";

const SECRET = "portal-test-cookie-secret";
const CSRF = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const NOW = new Date("2026-09-28T12:00:00.000Z");
export const EMAIL = "admin@example.com";
export const LATER = (ms: number) => new Date(NOW.getTime() + ms);

const DRIVER_SCOPES = JSON.stringify({
  namespaces: ["capsid"],
  repos: "*",
  tools: "*",
  grants: ["read", "write"],
  flags: {},
});

const agent = (id: string, name: string, hash: string, createdBy: string, day: string) => ({
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
export function world(opts: { adminEmail?: string; coOwners?: string } = {}): {
  d1: FakeD1;
  kv: FakeKv;
  env: never;
} {
  const d1 = fakeD1({
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
  });
  const kv = fakeKv({
    seed: {
      "gh:token:v3:owner/repo": "test-token",
    },
  });
  const env = {
    DB: withPortalSessionEnds(d1.db).db,
    APP_KV: kv.kv,
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    IMPROVE_SCORE_SECRET: "portal-test-signing-secret",
    ADMIN_EMAIL: opts.adminEmail ?? EMAIL,
    ...(opts.coOwners === undefined ? {} : { CO_OWNER_EMAILS: opts.coOwners }),
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
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

export const issue = (w: { env: never }) => previewOk(w, "revoke_agent", { name: "capsid-driver" });

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

export function auditRows(d1: FakeD1): string[] {
  return d1.recorded
    .filter((r) => /INSERT INTO audit_log/i.test(r.sql))
    .map((r) => `${r.params[1]} by ${r.params[0]}`);
}
