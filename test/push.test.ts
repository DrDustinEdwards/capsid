import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAITING_SEAT_KEY } from "../src/auto-merge-tick.ts";
import { PAUSED_KEY } from "../src/merge-safety.ts";
import { RETRY_CAP_REASON } from "../src/jobs-schema.ts";
import { PORTAL_CSRF_COOKIE } from "../src/ops-feed.ts";
import { PORTAL_CSRF_HEADER } from "../src/portal-actions.ts";
import { portalSessionCookie } from "../src/portal-auth.ts";
import { handlePortalPushGet, handlePortalPushPost, PORTAL_PUSH_PATH, pushTick, type PushPayload } from "../src/push.ts";
import type { PortalPush } from "../src/ops-types/views.ts";
import { b64url, fromB64url } from "../src/web-push.ts";
import { applyWrite, selectRows, type Row, type TableSpec } from "./fake-sql.ts";
import { fakeKv } from "./fakes.ts";

// Phone alerts (docs/design/design-merge-pipeline.md section 5, PR 7; DECIDE 5 and 6 of
// 2026-10-09): exactly five triggers, each sent once, never with an Approve button, never
// with a title. The encryption itself is in test/web-push.test.ts.

const NOW = new Date("2026-10-11T12:00:00.000Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const sqlTime = (ms: number) => iso(ms).replace("T", " ").slice(0, 19);

// A P-256 key pair for VAPID and one for the device, made fresh for the file.
async function keyPair(): Promise<{ jwk: JsonWebKey; raw: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = b64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  return { jwk: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, raw };
}
const VAPID = await keyPair();
const DEVICE = await keyPair();
const AUTH = b64url(crypto.getRandomValues(new Uint8Array(16)));
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

// D1 over the generic evaluator in test/fake-sql.ts, so every WHERE is applied.
function db(seed: { jobs?: Row[]; deploys?: Row[]; devices?: Row[] } = {}) {
  const tables: Record<string, TableSpec> = {
    jobs: { rows: seed.jobs ?? [], unique: [["id"]] },
    deploy_outcomes: { rows: seed.deploys ?? [], unique: [["repo", "run_id"]] },
    push_subscriptions: { rows: seed.devices ?? [], unique: [], autoId: true },
    audit_log: { rows: [], unique: [], autoId: true },
  };
  const writes: string[] = [];
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const tableOf = () => /FROM (\w+)/i.exec(sql)![1]!;
    const st = {
      sql,
      bind(...p: unknown[]) {
        params = p;
        return st;
      },
      async all() {
        return { results: selectRows(tables[tableOf()]!.rows, sql, params), meta: {} };
      },
      async first() {
        return selectRows(tables[tableOf()]!.rows, sql, params)[0] ?? null;
      },
      write() {
        writes.push(sql.replace(/\s+/g, " ").trim());
        const r = applyWrite(tables, sql, params)!;
        return { results: r.returning, meta: { changes: r.changes } };
      },
    };
    return st;
  };
  const d1 = { prepare, batch: async (sts: Array<{ write: () => unknown }>) => sts.map((s) => s.write()) };
  return { d1, tables, writes };
}

const device = (over: Row = {}): Row => ({ id: 1, endpoint: ENDPOINT, p256dh: DEVICE.raw, auth: AUTH, label: "Chrome on Android", status: "active", created_by: "access:admin@example.com", created_at: iso(-48 * H), ...over });
const typed = (number: number) => ({ namespace: "foxhound", repo: "owner/foxhound", number, failed: "paths_not_money", why: "money", at: NOW.toISOString(), class: "typed", path_class: "money", class_reasons: ["billing"] });
const approve = (number: number) => ({ ...typed(number), class: "approve", path_class: "src-routine" });

function world(opts: { awaiting?: object[]; jobs?: Row[]; deploys?: Row[]; devices?: Row[]; state?: object; key?: boolean; paused?: object } = {}) {
  const { d1, tables, writes } = db({ jobs: opts.jobs, deploys: opts.deploys, devices: opts.devices ?? [device()] });
  const seed: Record<string, string> = { [AWAITING_SEAT_KEY]: JSON.stringify(opts.awaiting ?? []) };
  if (opts.paused) seed[PAUSED_KEY] = JSON.stringify(opts.paused);
  if (opts.state) seed["push:state"] = JSON.stringify(opts.state);
  const kv = fakeKv({ seed });
  const env = {
    DB: d1,
    APP_KV: kv.kv,
    ADMIN_EMAIL: "admin@example.com",
    VAPID_PRIVATE_KEY: opts.key === false ? undefined : JSON.stringify(VAPID.jwk),
    COOKIE_ENCRYPTION_KEY: SECRET,
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
  } as never;
  return { env, tables, writes, kv };
}

/** A push service that decrypts what it is sent, as the device would, and answers `status`. */
function service(status = 201) {
  const got: PushPayload[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    got.push(JSON.parse(await decrypt(init!.body as Uint8Array)) as PushPayload);
    return new Response(null, { status });
  }) as typeof fetch;
  return { got, fetcher };
}

async function decrypt(body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + body[20]!);
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  const priv = await crypto.subtle.importKey("jwk", DEVICE.jwk, ecdh, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPublic, ecdh, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm, priv, 256));
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const enc = new TextEncoder();
  const ikm = await hk(fromB64url(AUTH), shared, new Uint8Array([...enc.encode("WebPush: info\0"), ...fromB64url(DEVICE.raw), ...asPublic]), 32);
  const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + body[20]!)));
  return new TextDecoder().decode(padded.slice(0, padded.lastIndexOf(2)));
}

// The six triggers

test("a typed pull request alerts only after 2 hours waiting, counted from the first tick that saw it", async () => {
  const w = world({ awaiting: [typed(7)] });
  const s = service();
  assert.equal((await pushTick(w.env, NOW, s.fetcher)).sent.length, 0, "alerted at once");
  // The first sighting is kept, because the awaiting-seat set is rewritten every tick.
  const seen = JSON.parse(w.kv.store.get("push:state")!) as { typed_seen: Record<string, string> };
  assert.equal(seen.typed_seen["owner/foxhound#7"], NOW.toISOString());
  assert.equal((await pushTick(w.env, new Date(NOW.getTime() + 2 * H), s.fetcher)).sent.length, 0, "alerted at exactly 2 hours");
  const later = await pushTick(w.env, new Date(NOW.getTime() + 2 * H + 60_000), s.fetcher);
  assert.deepEqual(later.sent, ["typed:owner/foxhound#7"]);
  assert.equal(s.got.length, 1);
  assert.equal(s.got[0]!.title, "Typed approval waiting");
  assert.match(s.got[0]!.body, /^owner\/foxhound#7, class typed/);
});

test("an approve-class pull request never alerts, however long it waits", async () => {
  const w = world({ awaiting: [approve(8)], state: { typed_seen: { "owner/foxhound#8": iso(-30 * H) }, sent: {} } });
  const s = service();
  const report = await pushTick(w.env, NOW, s.fetcher);
  assert.equal(report.sent.length, 0);
  assert.equal(s.got.length, 0);
});

test("a visual pull request alerts at once, once per head, and names no title", async () => {
  const visual = (sha: string) => ({ ...approve(9), failed: "visual_awaits_look", head_sha: sha, visual: { title: "Secret redesign", preview: "https://preview.example.com/", shots: [] } });
  const w = world({ awaiting: [visual("aaa")] });
  const s = service();
  assert.deepEqual((await pushTick(w.env, NOW, s.fetcher)).sent, ["visual:owner/foxhound#9:aaa"]);
  assert.equal(s.got[0]!.title, "Visual change to look at");
  assert.doesNotMatch(s.got[0]!.body, /Secret redesign/, "an alert carries no title");
  assert.equal((await pushTick(w.env, new Date(NOW.getTime() + 60_000), s.fetcher)).sent.length, 0, "sent twice for one head");
  await w.kv.kv.put("improve:awaiting-seat", JSON.stringify([visual("bbb")]));
  assert.deepEqual((await pushTick(w.env, new Date(NOW.getTime() + 120_000), s.fetcher)).sent, ["visual:owner/foxhound#9:bbb"], "a new push did not ask again");
});

test("a rollback and a failed rollback alert; a verified deploy and an old rollback do not", async () => {
  const deploys = [
    { repo: "owner/capsid", namespace: "capsid", run_id: 1, head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-H) },
    { repo: "owner/carrel", namespace: "carrel", run_id: 2, head_sha: "b".repeat(40), outcome: "rollback_failed", recorded_at: sqlTime(-2 * H) },
    { repo: "owner/capsid", namespace: "capsid", run_id: 3, head_sha: "c".repeat(40), outcome: "verified", recorded_at: sqlTime(-H) },
    { repo: "owner/capsid", namespace: "capsid", run_id: 4, head_sha: "d".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-30 * H) },
  ];
  const w = world({ deploys });
  const s = service();
  const report = await pushTick(w.env, NOW, s.fetcher);
  assert.deepEqual(report.sent.sort(), ["rollback:owner/capsid:1", "rollback:owner/carrel:2"]);
  assert.deepEqual(s.got.map((g) => g.title).sort(), ["Deploy rolled back", "Rollback failed"]);
});

test("PLANT: a namespace the safety shutoff paused alerts once, naming the namespace and the reason", async () => {
  const since = iso(-H);
  const w = world({ paused: { capsid: { since, reason: "2 of the pull requests auto-merge merged were rolled back or reverted in 7 days" } } });
  const s = service();
  const report = await pushTick(w.env, NOW, s.fetcher);
  assert.deepEqual(report.sent, [`paused:capsid:${since}`]);
  assert.equal(s.got[0]!.title, "Auto-merge paused");
  assert.equal(s.got[0]!.url, "https://portal.dustinedwards.info/prs#auto-merge");
  assert.match(s.got[0]!.body, /^capsid: 2 of the pull requests auto-merge merged were rolled back or reverted in 7 days\./);
  assert.equal((await pushTick(w.env, new Date(NOW.getTime() + 5 * 60_000), service().fetcher)).sent.length, 0, "the same pause alerted twice");
});

test("a job at the correction cap alerts; a question alerts only past 4 hours on priority 70 or more", async () => {
  const job = (id: string, priority: number, summary: string, ageMs: number): Row => ({ id, namespace: "capsid", title: "secret title", priority, status: "blocked", result_summary: summary, updated_at: iso(-ageMs) });
  const jobs = [
    job("job_cap", 10, `${RETRY_CAP_REASON}\n\nreview by x: CHANGES`, H),
    job("job_q_old_high", 70, "QUESTION: which one?", 4 * H + 60_000),
    job("job_q_young_high", 90, "QUESTION: which one?", 3 * H),
    job("job_q_old_low", 69, "QUESTION: which one?", 30 * H),
    job("job_blocked", 90, "run this command", 30 * H),
  ];
  const w = world({ jobs });
  const s = service();
  const report = await pushTick(w.env, NOW, s.fetcher);
  assert.deepEqual(report.sent.map((k) => k.split(":")[0] + ":" + k.split(":")[1]).sort(), ["cap:job_cap", "question:job_q_old_high"]);
  for (const g of s.got) assert.doesNotMatch(g.body, /secret title/, "an alert carried a job's title");
});

// Each sent once, never a button

test("an item is sent once, and the next tick sends nothing new", async () => {
  const w = world({ deploys: [{ repo: "owner/capsid", namespace: "capsid", run_id: 1, head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-H) }] });
  const s = service();
  assert.equal((await pushTick(w.env, NOW, s.fetcher)).sent.length, 1);
  const again = await pushTick(w.env, new Date(NOW.getTime() + 5 * 60_000), s.fetcher);
  assert.equal(again.sent.length, 0);
  assert.equal(again.ran, false);
  assert.equal(s.got.length, 1);
  assert.ok(w.tables.audit_log!.rows.some((r) => r.action === "push-sent"), "no audit row for the alert");
});

test("no alert carries an action, and every alert opens its own item on the Portal", async () => {
  const w = world({
    awaiting: [typed(7)],
    state: { typed_seen: { "owner/foxhound#7": iso(-3 * H) }, sent: {} },
    deploys: [{ repo: "owner/capsid", namespace: "capsid", run_id: 1, head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-H) }],
  });
  const s = service();
  await pushTick(w.env, NOW, s.fetcher);
  assert.equal(s.got.length, 2);
  for (const g of s.got) {
    assert.deepEqual(Object.keys(g).sort(), ["body", "tag", "title", "url"], "an alert carried more than title, body, url and tag");
  }
  assert.deepEqual(s.got.map((g) => g.url).sort(), ["https://portal.dustinedwards.info/health?tab=deploys", "https://portal.dustinedwards.info/prs#pr-owner-foxhound-7"]);
});

test("a job's alert opens its drawer on Jobs", async () => {
  const jobs: Row[] = [{ id: "job_cap", namespace: "capsid", title: "t", priority: 10, status: "blocked", result_summary: `${RETRY_CAP_REASON}\n\nreview`, updated_at: iso(-H) }];
  const w = world({ jobs });
  const s = service();
  await pushTick(w.env, NOW, s.fetcher);
  assert.deepEqual(s.got.map((g) => g.url), ["https://portal.dustinedwards.info/queue/job/job_cap"]);
});

test("at most three items go out per tick; the rest follow on the next", async () => {
  const deploys = [1, 2, 3, 4, 5].map((n) => ({ repo: "owner/capsid", namespace: "capsid", run_id: n, head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-H) }));
  const w = world({ deploys });
  const s = service();
  const first = await pushTick(w.env, NOW, s.fetcher);
  assert.equal(first.sent.length, 3);
  assert.match(first.note, /2 more next tick/);
  assert.equal((await pushTick(w.env, NOW, s.fetcher)).sent.length, 2);
});

// Devices and keys

test("a 410 marks the device gone, and the item is kept for a later device", async () => {
  const w = world({ deploys: [{ repo: "owner/capsid", namespace: "capsid", run_id: 1, head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-H) }] });
  const report = await pushTick(w.env, NOW, service(410).fetcher);
  assert.equal(report.sent.length, 0);
  assert.equal(w.tables.push_subscriptions!.rows[0]!.status, "gone");
  assert.ok(w.writes.some((s) => /^UPDATE push_subscriptions SET status = 'gone', .* WHERE id = \?1 AND status = 'active' RETURNING id$/.test(s)));
  const state = JSON.parse(w.kv.store.get("push:state") ?? "{\"sent\":{}}") as { sent: Record<string, string> };
  assert.deepEqual(state.sent, {}, "an alert no device received was marked sent");
});

test("no key, or no device, sends nothing and is not a run", async () => {
  const s = service();
  const unkeyed = await pushTick(world({ key: false, deploys: [{ repo: "owner/capsid", namespace: "capsid", run_id: 1, head_sha: "a".repeat(40), outcome: "rolled_back", recorded_at: sqlTime(-H) }] }).env, NOW, s.fetcher);
  assert.equal(unkeyed.ran, false);
  assert.match(unkeyed.note, /VAPID_PRIVATE_KEY is not set/);
  const lonely = await pushTick(world({ devices: [device({ status: "off" })] }).env, NOW, s.fetcher);
  assert.equal(lonely.ran, false);
  assert.match(lonely.note, /no device/);
  assert.equal(s.got.length, 0);
});

// The Portal's route

const SECRET = "push-test-cookie-secret";
const CSRF = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

async function request(method: "GET" | "POST", body?: unknown, opts: { site?: string } = {}): Promise<Request> {
  const session = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, NOW)).split(";")[0];
  const headers: Record<string, string> = { Cookie: `${session}; ${PORTAL_CSRF_COOKIE}=${CSRF}`, [PORTAL_CSRF_HEADER]: CSRF, "Sec-Fetch-Site": opts.site ?? "same-origin", "Content-Type": "application/json" };
  return new Request(`https://capsid.example${PORTAL_PUSH_PATH}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/device-2", keys: { p256dh: DEVICE.raw, auth: AUTH } };

test("GET lists the public key and the devices, never an endpoint", async () => {
  const w = world();
  const res = await handlePortalPushGet(await request("GET"), w.env, NOW);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /fcm\.googleapis\.com/);
  const body = JSON.parse(text) as PortalPush;
  assert.equal(body.devices.length, 1);
  assert.equal(body.public_key?.length, 87);
  const unkeyed = (await (await handlePortalPushGet(await request("GET"), world({ key: false }).env, NOW)).json()) as PortalPush;
  assert.equal(unkeyed.public_key, null);
  assert.match(unkeyed.problem!, /not set/);
});

test("POST on stores a subscription once, off moves it once, and each is audited", async () => {
  const w = world({ devices: [] });
  const on = await handlePortalPushPost(await request("POST", { op: "on", subscription, label: "Pixel" }), w.env, NOW);
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal(((await on.json()) as PortalPush).devices.length, 1);
  await handlePortalPushPost(await request("POST", { op: "on", subscription, label: "Pixel" }), w.env, NOW);
  assert.equal(w.tables.push_subscriptions!.rows.length, 1, "the same browser was stored twice");
  const off = await handlePortalPushPost(await request("POST", { op: "off", id: 1 }), w.env, NOW);
  assert.equal(off.status, 200);
  assert.equal(w.tables.push_subscriptions!.rows[0]!.status, "off");
  assert.equal((await handlePortalPushPost(await request("POST", { op: "off", id: 1 }), w.env, NOW)).status, 409);
  assert.deepEqual(w.tables.audit_log!.rows.map((r) => r.action), ["push-device-on", "push-device-off"]);
  assert.doesNotMatch(JSON.stringify(w.tables.audit_log!.rows), /device-2/, "the audit row carried the endpoint");
});

test("POST refuses an endpoint off the push services, a cross-site request and an unknown op", async () => {
  const w = world({ devices: [] });
  const bad = await handlePortalPushPost(await request("POST", { op: "on", subscription: { ...subscription, endpoint: "https://evil.example.com/x" } }), w.env, NOW);
  assert.equal(bad.status, 400);
  assert.equal((await handlePortalPushPost(await request("POST", { op: "on", subscription }, { site: "cross-site" }), w.env, NOW)).status, 403);
  assert.equal((await handlePortalPushPost(await request("POST", { op: "approve" }), w.env, NOW)).status, 400);
  assert.equal(w.tables.push_subscriptions!.rows.length, 0);
});

test("POST test sends one alert to each device and reports each answer", async () => {
  const w = world();
  const s = service();
  const res = await handlePortalPushPost(await request("POST", { op: "test" }), w.env, NOW, s.fetcher);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as PortalPush).results, [{ id: 1, status: 201 }]);
  assert.equal(s.got[0]!.title, "Capsid test alert");
});
