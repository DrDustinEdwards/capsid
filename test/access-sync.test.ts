import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { ACCESS_SYNC_PERMISSION, handleAccessSync, parseSyncBody, runSync, type PinnedGroup } from "../src/access-sync.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";

// The Access sync (src/access-sync.ts): an app's members list made its pinned Access
// group, with Capsid's token only. What matters is what it refuses to write: a group whose
// name is not the pinned one, a group holding a rule the sync would erase, a namespace the
// key does not hold, and a seat of someone still on the list.

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "sample-access-sync-token-0000";
const GROUP: PinnedGroup = { group_id: "11111111-2222-3333-4444-555555555555", group_name: "lab-people" };
const GROUP_PATH = `/client/v4/accounts/${ACCOUNT}/access/groups/${GROUP.group_id}`;
const USERS_PATH = `/client/v4/accounts/${ACCOUNT}/access/users`;
const SEATS_PATH = `/client/v4/accounts/${ACCOUNT}/access/seats`;
const APP_KEY = "capsid_agent_" + "a".repeat(64);

type Answer = { status?: number; body: unknown };
interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  bearer: boolean;
}
const ok = (result: unknown, result_info?: unknown): Answer => ({ body: { success: true, errors: [], messages: [], result, ...(result_info ? { result_info } : {}) } });
const refused = (status: number, message: string): Answer => ({ status, body: { success: false, errors: [{ code: 10000, message }], messages: [], result: null } });
const emailRule = (email: string) => ({ email: { email } });

// Cloudflare as the four calls answer, keyed "METHOD /path". Every call is recorded.
function cloudflare(routes: Record<string, Answer | ((call: Call) => Answer)>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? "GET",
      path: u.pathname,
      params: Object.fromEntries(u.searchParams),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      bearer: headers.Authorization === `Bearer ${TOKEN}`,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) throw new Error(`connect failed for ${call.method} ${call.path}`);
    const answer = typeof route === "function" ? route(call) : route;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { impl, calls };
}

const group = (include: unknown[], extra: Record<string, unknown> = {}) => ok({ id: GROUP.group_id, name: GROUP.group_name, include, exclude: [], require: [], ...extra });
const req = (members: string[], removed: string[] = []) => ({ namespace: "sample", members, removed });

test("parse: emails are normalized and deduplicated, and anything outside the contract refuses the whole body", () => {
  const parsed = parseSyncBody({ namespace: "sample", members: [" Rosa@Example.com", "rosa@example.com", "sam@example.com"], removed: ["JO@example.com"] });
  assert.deepEqual(parsed, { ok: true, value: { namespace: "sample", members: ["rosa@example.com", "sam@example.com"], removed: ["jo@example.com"] } });
  assert.match((parseSyncBody({ namespace: "sample", members: [], group_id: "x" }) as { refusal: string }).refusal, /unknown field 'group_id'/);
  assert.match((parseSyncBody({ namespace: "sample", members: ["not an email"] }) as { refusal: string }).refusal, /members\[0\] is not an email/);
  assert.match((parseSyncBody({ namespace: "sample", members: "rosa@example.com" }) as { refusal: string }).refusal, /whole current list/);
  assert.match((parseSyncBody({ namespace: "sample", members: Array.from({ length: 1001 }, (_, i) => `p${i}@example.com`) }) as { refusal: string }).refusal, /at most 1000/);
});

test("plant: a group whose name is not the pinned one is refused and never written", async () => {
  const cf = cloudflare({ [`GET ${GROUP_PATH}`]: ok({ name: "admins", include: [emailRule("dustin@example.com")] }) });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com"]));
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.refusal ?? "", /not the pinned "lab-people"/);
  assert.deepEqual(cf.calls.map((c) => c.method), ["GET"]);
});

test("plant: a group holding a rule that is not one email is refused, so a hand-made rule is never erased", async () => {
  const cf = cloudflare({ [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com"), { email_domain: { domain: "example.com" } }]) });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com"]));
  assert.equal(result.conflict, true);
  assert.deepEqual(cf.calls.map((c) => c.method), ["GET"]);
});

test("the write is the whole list, one email rule each, keeping the group's exclude and require rules", async () => {
  const exclude = [{ email: { email: "former@example.com" } }];
  const require = [{ geo: { country_code: "US" } }];
  const cf = cloudflare({
    [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com"), emailRule("jo@example.com")], { exclude, require }),
    [`PUT ${GROUP_PATH}`]: ok({ id: GROUP.group_id }),
  });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com", "sam@example.com"]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, ["sam@example.com"]);
  assert.deepEqual(result.dropped, ["jo@example.com"]);
  assert.equal(result.members, 2);
  const put = cf.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { name: "lab-people", include: [emailRule("rosa@example.com"), emailRule("sam@example.com")], exclude, require });
  assert.ok(cf.calls.every((c) => c.bearer), "every call carries the token");
});

test("a refused write names the permission the token lacks and Cloudflare's words, never the token", async () => {
  const cf = cloudflare({
    [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com")]),
    [`PUT ${GROUP_PATH}`]: refused(403, "Authentication error"),
  });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com", "sam@example.com"]));
  assert.equal(result.ok, false);
  assert.equal(result.conflict, false);
  assert.equal(result.cloudflare_status, 403);
  assert.match(result.refusal ?? "", new RegExp(`lacks ${ACCESS_SYNC_PERMISSION.group}`));
  assert.match(result.refusal ?? "", /Authentication error/);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("plant: a removed person still on the list keeps their seat, and only an exact email match frees one", async () => {
  const cf = cloudflare({
    [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com"), emailRule("jo@example.com"), emailRule("ghost@example.com")]),
    [`PUT ${GROUP_PATH}`]: ok({}),
    // A users list that ignores the email filter: everyone comes back.
    [`GET ${USERS_PATH}`]: ok(
      [
        { email: "rosa@example.com", seat_uid: "seat-rosa" },
        { email: "jo@example.com", seat_uid: "seat-jo" },
        { email: "jo@example.com.evil.test", seat_uid: "seat-evil" },
      ],
      { page: 1, total_pages: 1 },
    ),
    [`PATCH ${SEATS_PATH}`]: ok([]),
  });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com"], ["jo@example.com", "rosa@example.com", "ghost@example.com"]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.seats.kept, ["rosa@example.com"]);
  assert.deepEqual(result.seats.freed, ["jo@example.com"]);
  assert.deepEqual(result.seats.not_found, ["ghost@example.com"]);
  const patch = cf.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch?.body, [{ seat_uid: "seat-jo", access_seat: false, gateway_seat: false }]);
  const looked = cf.calls.filter((c) => c.path === USERS_PATH).map((c) => c.params.email);
  assert.deepEqual(looked.sort(), ["ghost@example.com", "jo@example.com"], "a member's seat is never even looked up");
});

test("PLANT: a removed email the group never held is not looked up and its seat is never freed", async () => {
  const cf = cloudflare({
    [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com"), emailRule("jo@example.com")]),
    [`PUT ${GROUP_PATH}`]: ok({}),
    [`GET ${USERS_PATH}`]: ok(
      [
        { email: "jo@example.com", seat_uid: "seat-jo" },
        { email: "outsider@example.com", seat_uid: "seat-outsider" },
      ],
      { page: 1, total_pages: 1 },
    ),
    [`PATCH ${SEATS_PATH}`]: ok([]),
  });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com"], ["jo@example.com", "outsider@example.com"]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.seats.freed, ["jo@example.com"]);
  assert.deepEqual(result.seats.not_members, ["outsider@example.com"]);
  const looked = cf.calls.filter((c) => c.path === USERS_PATH).map((c) => c.params.email);
  assert.deepEqual(looked, ["jo@example.com"]);
  const patch = cf.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch?.body, [{ seat_uid: "seat-jo", access_seat: false, gateway_seat: false }]);
});

test("a seat that cannot be freed is reported, and the group write still counts", async () => {
  const cf = cloudflare({
    [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com"), emailRule("jo@example.com")]),
    [`PUT ${GROUP_PATH}`]: ok({}),
    [`GET ${USERS_PATH}`]: ok([{ email: "jo@example.com", seat_uid: "seat-jo" }]),
    [`PATCH ${SEATS_PATH}`]: refused(403, "Authentication error"),
  });
  const result = await runSync(cf.impl, TOKEN, ACCOUNT, GROUP, req(["rosa@example.com"], ["jo@example.com"]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.seats.freed, []);
  assert.match(result.seats.failed ?? "", new RegExp(`lacks ${ACCESS_SYNC_PERMISSION.seats}`));
});

// The route, end to end on the fakes.

async function appEnv(opts: { pinned?: boolean; token?: boolean; namespaces?: string[] } = {}) {
  const scopes = defaultScopes(opts.namespaces ?? ["sample"]);
  scopes.grants = ["read", "write"];
  const d1 = fakeD1({
    agents: [
      {
        id: "agent_app000000001",
        name: "sample-app",
        kind: "session",
        key_hash: await sha256Hex(APP_KEY),
        scopes: serializeScopes(scopes),
        created_by: "access:admin@example.com",
        created_at: "2026-10-10 00:00:00",
        revoked_at: null,
        last_seen: null,
      },
    ],
  });
  const env = fakeEnv({
    DB: d1.db,
    APP_KV: fakeKv().kv,
    OPERATOR_KEY_HASH: "",
    CF_ACCOUNT_ID: ACCOUNT,
    ...(opts.token === false ? {} : { CF_ACCESS_SYNC_TOKEN: TOKEN }),
  });
  const pinned = async (_db: D1Database, namespace: string) => (opts.pinned === false || namespace !== "sample" ? null : GROUP);
  return { d1, env, pinned };
}

const post = (body: unknown, key: string | null = APP_KEY) =>
  new Request("https://capsid.example.com/ops/access-sync", {
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("route: no key is a 401, another namespace a 403, and neither reaches Cloudflare", async () => {
  const { env, pinned } = await appEnv();
  const cf = cloudflare({});
  const deps = { fetch: cf.impl, now: new Date("2026-10-10T12:00:00Z"), pinned };
  assert.equal((await handleAccessSync(post(req(["rosa@example.com"]), null), env, deps)).status, 401);
  const other = await handleAccessSync(post({ namespace: "carrel", members: ["rosa@example.com"] }), env, deps);
  assert.equal(other.status, 403);
  assert.equal(cf.calls.length, 0);
});

test("route: no pinned group is a 409 and no token a 503, both before any Cloudflare call", async () => {
  const unpinned = await appEnv({ pinned: false });
  const cf = cloudflare({});
  assert.equal((await handleAccessSync(post(req(["rosa@example.com"])), unpinned.env, { fetch: cf.impl, now: new Date(), pinned: unpinned.pinned })).status, 409);
  const tokenless = await appEnv({ token: false });
  const res = await handleAccessSync(post(req(["rosa@example.com"])), tokenless.env, { fetch: cf.impl, now: new Date(), pinned: tokenless.pinned });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /CF_ACCESS_SYNC_TOKEN is not set/);
  assert.equal(cf.calls.length, 0);
});

test("route: a written sync answers 200 and writes one audit row naming the app's key and Cloudflare's answer", async () => {
  const { d1, env, pinned } = await appEnv();
  const cf = cloudflare({ [`GET ${GROUP_PATH}`]: group([emailRule("rosa@example.com")]), [`PUT ${GROUP_PATH}`]: ok({}) });
  const res = await handleAccessSync(post(req(["rosa@example.com", "sam@example.com"])), env, { fetch: cf.impl, now: new Date(), pinned });
  assert.equal(res.status, 200);
  const audit = (d1.rows.audit_log as Array<Record<string, unknown>>).filter((a) => a.action === "access-sync");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.actor, "agent:sample-app");
  assert.equal(audit[0]?.namespace, "sample");
  const params = JSON.parse(String(audit[0]?.params)) as { ok: boolean; added: string[]; group_name: string };
  assert.deepEqual([params.ok, params.added, params.group_name], [true, ["sam@example.com"], "lab-people"]);
});

test("route: a Cloudflare refusal is a 502 and is audited too; a name mismatch is a 409", async () => {
  const { d1, env, pinned } = await appEnv();
  const refusing = cloudflare({ [`GET ${GROUP_PATH}`]: refused(500, "Internal error") });
  assert.equal((await handleAccessSync(post(req(["rosa@example.com"])), env, { fetch: refusing.impl, now: new Date(), pinned })).status, 502);
  const renamed = cloudflare({ [`GET ${GROUP_PATH}`]: ok({ name: "lab-people-old", include: [] }) });
  assert.equal((await handleAccessSync(post(req(["rosa@example.com"])), env, { fetch: renamed.impl, now: new Date(), pinned })).status, 409);
  const audit = (d1.rows.audit_log as Array<Record<string, unknown>>).filter((a) => a.action === "access-sync").map((a) => JSON.parse(String(a.params)) as { ok: boolean; conflict: boolean });
  assert.deepEqual(audit.map((a) => [a.ok, a.conflict]), [[false, false], [false, true]]);
});
