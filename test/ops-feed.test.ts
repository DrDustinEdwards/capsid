import assert from "node:assert/strict";
import { test } from "node:test";
import { portalDisplay, portalSessionCookie } from "../src/portal-auth.ts";
import { RESUME_MARKER } from "../src/jobs.ts";
import {
  awaitingFrom,
  handleOpsFeed,
  handleOpsRefresh,
  isoTime,
  OPS_FEED_PATH,
  OPS_REFRESH_HEADER,
  OPS_REFRESH_KEY,
  OPS_REFRESH_PATH,
  opsAgentFrom,
  PORTAL_CSRF_COOKIE,
  type OpsFeedData,
  opsJobFrom,
  refreshAllowedAt,
  seatRecentFrom,
  type JobFeedRow,
  type SeatAuditRow,
} from "../src/ops-feed.ts";
import { OPS_SNAPSHOT_KEY } from "../src/ops-snapshot.ts";
import { runUrl } from "../src/runner-key.ts";
import { openWatcherFingerprints, watcherTick, WATCHER_ACTOR, WATCHER_LAST_KEY, type Gathered } from "../src/watcher.ts";
import { agentRecord, fakeEnv, fakeKv } from "./fakes.ts";

// The Watch Floor feed and its Refresh (src/ops-feed.ts). The live reads are driven
// against real D1 in test-integration/ops-feed.test.ts, which also counts them; these
// cover the shaping, the gate, the header and the rate limit.

const SECRET = "ops-feed-test-cookie-secret";
const NOW = new Date("2026-09-28T12:00:00.000Z");

const job = (over: Partial<JobFeedRow> = {}): JobFeedRow => ({
  id: "job_000000000001",
  namespace: "sample",
  title: "a job",
  status: "queued",
  priority: 0,
  posted_by: "github:sample",
  claimed_by: null,
  created_at: "2026-09-28 10:00:00",
  updated_at: "2026-09-28T11:00:00.000Z",
  lease_expires: null,
  blocked_count: 0,
  resumed_count: 0,
  gate_required: 0,
  result_ref: null,
  result_summary: null,
  ...over,
});

// Shaping

test("a blocked job's summary is split into what it waits on and the exact command", () => {
  // The summary exactly as blockJob writes it.
  const summary = `waiting on the push\n\n${RESUME_MARKER}\n\n    git push -u origin feat/x`;
  const shaped = opsJobFrom(job({ status: "blocked", result_summary: summary, gate_required: 1 }));
  assert.equal(shaped.waits_on, "waiting on the push");
  assert.equal(shaped.command, "git push -u origin feat/x");
  assert.equal(shaped.gate_required, true);
  const noCommand = opsJobFrom(job({ status: "blocked", result_summary: "a reason only" }));
  assert.equal(noCommand.waits_on, "a reason only");
  assert.equal(noCommand.command, null);
  // A job that is not blocked carries neither, whatever its summary says.
  const done = opsJobFrom(job({ status: "done", result_summary: summary }));
  assert.equal(done.waits_on, null);
  assert.equal(done.command, null);
});

test("D1's datetime('now') form is handed over as ISO, and ISO passes through", () => {
  assert.equal(isoTime("2026-09-28 10:00:00"), "2026-09-28T10:00:00Z");
  assert.equal(isoTime("2026-09-28T11:00:00.000Z"), "2026-09-28T11:00:00.000Z");
  assert.equal(isoTime(null), null);
  const shaped = opsJobFrom(job());
  assert.equal(shaped.created_at, "2026-09-28T10:00:00Z");
  assert.equal(Date.parse(shaped.created_at), Date.parse("2026-09-28T10:00:00.000Z"));
});

test("a watcher job's fingerprint is read exactly as openWatcherFingerprints reads it", async () => {
  const titles = [
    "Watcher: CI red on master [ci-red-abc1234]",
    "Watcher: trailing space [mirror-stale]  ",
    "Watcher: a [bracket] mid-title [site-down-sample]",
    "Watcher: no fingerprint at all",
  ];
  const rows = titles.map((title, i) => ({ id: `job_00000000000${i}`, title }));
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) };
  const watcher = await openWatcherFingerprints(fakeEnv({ DB: db }));
  const fromWatcher = new Map([...watcher].map(([fp, id]) => [id, fp]));
  assert.equal(fromWatcher.size, 3, "the fixtures must give the watcher three fingerprints, or the comparison below proves little");
  for (const row of rows) {
    const shaped = opsJobFrom(job({ id: row.id, title: row.title, posted_by: WATCHER_ACTOR }));
    assert.equal(shaped.finding?.fingerprint ?? null, fromWatcher.get(row.id) ?? null, row.title);
  }
  // Anyone else's bracketed title is not a finding.
  assert.equal(opsJobFrom(job({ title: "mine [not-a-finding]" })).finding, null);
});

test("an agent is shown with the record improve_status computes for it, and without its grants", () => {
  const record = agentRecord({
    jobs_done: 4,
    jobs_failed: 1,
    jobs_blocked: 2,
    prs_opened: 3,
    prs_merged: 2,
    pr_merge_rate: 0.667,
    ci_green_rate: null,
    median_duration_minutes: 12,
    attempts_kept: 5,
    attempts_reverted: 7,
  });
  const shaped = opsAgentFrom({
    name: "sample-driver",
    kind: "driver",
    namespaces: ["sample"],
    grants: ["read", "write"],
    flags: ["can_merge"],
    max_claims: 1,
    last_seen: "2026-09-28 11:00:00",
    revoked_at: null,
    record,
  });
  assert.deepEqual(shaped, {
    name: "sample-driver",
    kind: "driver",
    namespaces: ["sample"],
    flags: ["can_merge"],
    last_seen: "2026-09-28T11:00:00Z",
    revoked_at: null,
    jobs_done: 4,
    jobs_failed: 1,
    jobs_blocked: 2,
    prs_opened: 3,
    prs_merged: 2,
    pr_merge_rate: 0.667,
    ci_green_rate: null,
    median_duration_minutes: 12,
    attempts_kept: 5,
    attempts_reverted: 7,
  });
});

test("each seat start is joined to the runner-key mint that names it, newest first", () => {
  const rows: SeatAuditRow[] = [
    { id: 10, action: "job-seat-started", namespace: "sample", at: "2026-09-27 09:00:00", params: JSON.stringify({ job_id: "job_aaaaaaaaaaaa", repo: "sample-owner/sample" }) },
    { id: 11, action: "runner-key-minted", namespace: "sample", at: "2026-09-27 09:02:00", params: JSON.stringify({ job_id: "job_aaaaaaaaaaaa", start_audit_id: 10, run_id: "123456789", run_url: "https://github.com/sample-owner/sample/actions/runs/123456789" }) },
    // A mint written before run_url was recorded: the URL is built from the start's repo.
    { id: 20, action: "job-seat-started", namespace: "sample", at: "2026-09-28 09:00:00", params: JSON.stringify({ job_id: "job_bbbbbbbbbbbb", repo: "sample-owner/sample" }) },
    { id: 21, action: "runner-key-minted", namespace: "sample", at: "2026-09-28 09:02:00", params: JSON.stringify({ job_id: "job_bbbbbbbbbbbb", start_audit_id: 20, run_id: "987654321" }) },
    // A start whose runner never presented its token.
    { id: 30, action: "job-seat-started", namespace: "sample", at: "2026-09-28 11:00:00", params: JSON.stringify({ job_id: "job_cccccccccccc", repo: "sample-owner/sample" }) },
  ];
  assert.deepEqual(seatRecentFrom(rows), [
    { job_id: "job_cccccccccccc", namespace: "sample", at: "2026-09-28T11:00:00Z", run_id: null, run_url: null },
    { job_id: "job_bbbbbbbbbbbb", namespace: "sample", at: "2026-09-28T09:00:00Z", run_id: 987654321, run_url: "https://github.com/sample-owner/sample/actions/runs/987654321" },
    { job_id: "job_aaaaaaaaaaaa", namespace: "sample", at: "2026-09-27T09:00:00Z", run_id: 123456789, run_url: "https://github.com/sample-owner/sample/actions/runs/123456789" },
  ]);
});

test("a run URL is built only from a run id that is a positive integer", () => {
  assert.equal(runUrl("sample-owner/sample", "42"), "https://github.com/sample-owner/sample/actions/runs/42");
  assert.equal(runUrl("sample-owner/sample", 42), "https://github.com/sample-owner/sample/actions/runs/42");
  for (const bad of [undefined, null, "", "0", "-1", "42/../../x", "1e9", "1234567890123456"]) {
    assert.equal(runUrl("sample-owner/sample", bad), null, String(bad));
  }
});

test("an awaiting-seat value that does not parse is logged, never passed through", () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  try {
    assert.deepEqual(awaitingFrom("{not json"), []);
    assert.deepEqual(awaitingFrom(JSON.stringify({ not: "an array" })), []);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
  assert.match(errors[0], /OPS_FEED_AWAITING_UNREADABLE/);
  assert.deepEqual(awaitingFrom(null), []);
});

test("refresh_allowed_at is two minutes after the last on-demand pass, and null once that has passed", () => {
  assert.equal(refreshAllowedAt(null, NOW), null);
  assert.equal(refreshAllowedAt(new Date(NOW.getTime() - 30_000).toISOString(), NOW), new Date(NOW.getTime() + 90_000).toISOString());
  assert.equal(refreshAllowedAt(new Date(NOW.getTime() - 120_000).toISOString(), NOW), null);
});

// The gate

function env(kv = fakeKv(), db: unknown = recordingDb().db) {
  return fakeEnv({
    APP_KV: kv.kv,
    DB: db,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_EMAIL: "admin@example.com",
    ACCESS_TEAM_DOMAIN: "https://sample.cloudflareaccess.com",
    ACCESS_SAAS_CLIENT_ID: "sample-client",
    ACCESS_SAAS_CLIENT_SECRET: "sample-secret",
    OAUTH_KV: fakeKv().kv,
  });
}

// A D1 stub that answers every read with no rows and records every batch.
function recordingDb() {
  const batches: Array<Array<{ sql: string; params: unknown[] }>> = [];
  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: [] }),
    first: async () => null,
    run: async () => ({}),
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Array<{ sql: string; params: unknown[] }>) => {
      batches.push(list.map((s) => ({ sql: s.sql, params: s.params })));
      return [];
    },
  };
  return { db, batches };
}

const FEED: OpsFeedData = {
  snapshot: null,
  scheduled: { tasks: [], error: null },
  live: {
    generated: NOW.toISOString(),
    store: { size_bytes: null, cap_bytes: 10 * 1024 ** 3 },
    jobs: [],
    agents: [],
    prs: [],
    awaiting_seat: [],
    seat_start: { enabled: false, max_sessions: 1, in_flight: 0, recent: [] },
    overnight: { mode: "off", decision: null },
    sessions: [],
    loop: { mode: "off", budget: { month: "2026-09", caps: { actions_minutes_month: 1, model_usd_month: 1 }, spend: { ci_minutes: 0, cost_usd: 0 }, exceeded: false } },
    sites: [],
    packages: [],
    namespaces: [{ name: "sample", paused: null }],
  },
  refresh_allowed_at: null,
  cloudflare_configured: false,
};
const feed = async () => FEED;

async function signed(path: string, init: RequestInit = {}): Promise<Request> {
  const cookie = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, NOW)).split(";")[0];
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return new Request(`https://capsid.example${path}`, { ...init, headers });
}

test("the feed answers a signed-in administrator with the feed, uncached", async () => {
  const res = await handleOpsFeed(await signed(OPS_FEED_PATH), env(), NOW, { feed });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
  const body = (await res.json()) as { csrf: string };
  assert.deepEqual(body, { ...FEED, csrf: body.csrf, user: { name: "admin", initials: "A" } });
});

// Who is signed in (the top bar's avatar)

test("the feed names the signed-in person from the session: the token's name, else the email's local part", async () => {
  for (const [user, expected] of [
    [{ email: "admin@example.com", name: "Dustin Edwards" }, { name: "Dustin Edwards", initials: "DE" }],
    [{ email: "admin@example.com" }, { name: "admin", initials: "A" }],
  ] as const) {
    const cookie = (await portalSessionCookie(user, SECRET, NOW)).split(";")[0];
    const req = new Request(`https://capsid.example${OPS_FEED_PATH}`, { headers: { Cookie: cookie } });
    const body = (await (await handleOpsFeed(req, env(), NOW, { feed })).json()) as { user: unknown };
    assert.deepEqual(body.user, expected);
  }
});

test("portalDisplay: another person gets their own name and initials, never a fixed label", () => {
  assert.deepEqual(portalDisplay({ email: "jane.q.public@example.com" }), { name: "jane.q.public", initials: "JP" });
  assert.deepEqual(portalDisplay({ email: "x@example.com", name: "Mary-Jane O'Neil" }), { name: "Mary-Jane O'Neil", initials: "MO" });
  assert.deepEqual(portalDisplay({ email: "x@example.com", name: "Cher" }), { name: "Cher", initials: "C" });
});

// The Portal's CSRF value

const CSRF_VALUE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// A signed request that also carries a Portal CSRF cookie.
async function signedWithCsrf(path: string, csrf: string, init: RequestInit = {}): Promise<Request> {
  const req = await signed(path, init);
  req.headers.set("Cookie", `${req.headers.get("Cookie")}; ${PORTAL_CSRF_COOKIE}=${csrf}`);
  return req;
}

test("the feed and the refresh mint the Portal CSRF cookie when the request has none, and the body carries its value", async () => {
  for (const [path, handler, init] of [
    [OPS_FEED_PATH, handleOpsFeed, {}],
    [OPS_REFRESH_PATH, handleOpsRefresh, { method: "POST", headers: { [OPS_REFRESH_HEADER]: "refresh" } }],
  ] as const) {
    const res = await handler(await signed(path, init), env(), NOW, { feed, gather: gathered });
    assert.equal(res.status, 200, await res.clone().text());
    const set = res.headers.get("Set-Cookie") ?? "";
    const { csrf } = (await res.json()) as { csrf: string };
    assert.match(csrf, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(set.startsWith(`${PORTAL_CSRF_COOKIE}=${csrf};`), `${path} did not set the body's csrf as the cookie: ${set}`);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/portal", "Max-Age=43200"]) {
      assert.ok(set.includes(attribute), `the cookie lacks ${attribute}: ${set}`);
    }
  }
});

test("a present Portal CSRF cookie is echoed and never re-set, so a poll does not rotate it", async () => {
  const res = await handleOpsFeed(await signedWithCsrf(OPS_FEED_PATH, CSRF_VALUE), env(), NOW, { feed });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Set-Cookie"), null, "a present cookie was rotated");
  assert.equal(((await res.json()) as { csrf: string }).csrf, CSRF_VALUE);
});

test("a malformed Portal CSRF cookie is replaced, not echoed", async () => {
  const res = await handleOpsFeed(await signedWithCsrf(OPS_FEED_PATH, "not-a-token"), env(), NOW, { feed });
  const { csrf } = (await res.json()) as { csrf: string };
  assert.notEqual(csrf, "not-a-token");
  assert.ok((res.headers.get("Set-Cookie") ?? "").startsWith(`${PORTAL_CSRF_COOKIE}=${csrf};`));
});

test("the feed and the refresh refuse a bearer with 403 and send an anonymous reader to sign in", async () => {
  for (const [path, method, handler] of [
    [OPS_FEED_PATH, "GET", handleOpsFeed],
    [OPS_REFRESH_PATH, "POST", handleOpsRefresh],
  ] as const) {
    const bearer = await handler(
      new Request(`https://capsid.example${path}`, { method, headers: { Authorization: "Bearer capsid_x", [OPS_REFRESH_HEADER]: "refresh" } }),
      env(),
      NOW,
      { feed }
    );
    assert.equal(bearer.status, 403, `${path} served a bearer`);
    // A bearer beside a valid session is still refused: the gate reads the header first.
    const both = await handler(await signed(path, { method, headers: { Authorization: "Bearer capsid_x", [OPS_REFRESH_HEADER]: "refresh" } }), env(), NOW, { feed });
    assert.equal(both.status, 403, `${path} served a bearer that also carried a session`);
    const anonymous = await handler(new Request(`https://capsid.example${path}`, { method, headers: { [OPS_REFRESH_HEADER]: "refresh" } }), env(), NOW, { feed });
    assert.equal(anonymous.status, 302, `${path} did not send an anonymous reader to sign in`);
    assert.equal(await anonymous.text(), "");
  }
});

// The refresh

const gathered = async (): Promise<Gathered> => ({
  findings: [],
  ran: new Set(["health"] as const),
  observed: { health: null, mirror: null, ci: [], siteMap: null, probes: [] },
});

const refreshRequest = (headers: Record<string, string> = { [OPS_REFRESH_HEADER]: "refresh" }) =>
  signed(OPS_REFRESH_PATH, { method: "POST", headers });

test("a refresh without the same-origin header is refused with 403, and nothing runs", async () => {
  const kv = fakeKv();
  const variants: Array<Record<string, string>> = [{}, { [OPS_REFRESH_HEADER]: "yes" }];
  for (const headers of variants) {
    const res = await handleOpsRefresh(await refreshRequest(headers), env(kv), NOW, { feed, gather: gathered });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /X-Capsid-Ops: refresh/);
  }
  assert.deepEqual(kv.puts, [], "a refused refresh wrote to KV");
});

test("PLANT: the refresh runs a watcher pass even when the cadence says one is not due", async () => {
  // The watcher ran a minute ago, so the five-minute tick would skip. The refresh must not.
  const kv = fakeKv({ seed: { [WATCHER_LAST_KEY]: new Date(NOW.getTime() - 60_000).toISOString() } });
  const { db, batches } = recordingDb();
  const notDue = await watcherTick(env(kv, db), NOW, gathered);
  assert.equal(notDue.ran, false, "the fixture must be a pass the cadence refuses, or this proves nothing about force");

  const res = await handleOpsRefresh(await refreshRequest(), env(kv, db), NOW, { feed, gather: gathered });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { csrf: string };
  assert.deepEqual(body, { ...FEED, csrf: body.csrf, user: { name: "admin", initials: "A" } });
  assert.equal(kv.store.get(WATCHER_LAST_KEY), NOW.toISOString(), "no pass ran");
  assert.ok(kv.store.has(OPS_SNAPSHOT_KEY), "the pass wrote no snapshot");
  assert.equal(kv.store.get(OPS_REFRESH_KEY), NOW.toISOString(), "the rate-limit stamp was not written");

  // The click's own audit row, naming the administrator.
  const audit = batches.flat().find((s) => /INSERT INTO audit_log/.test(s.sql));
  assert.ok(audit, "the refresh wrote no audit row");
  assert.equal(audit.params[0], "access:admin@example.com");
  assert.equal(audit.params[1], "portal-ops-refresh");
  assert.equal(JSON.parse(String(audit.params[4])).ran, true);
  // No CF-Connecting-IP on this request: recorded as null, not left out.
  assert.equal(JSON.parse(String(audit.params[4])).source_address, null);
});

test("a refresh's audit row records the address it came from", async () => {
  const { db, batches } = recordingDb();
  const res = await handleOpsRefresh(await refreshRequest({ [OPS_REFRESH_HEADER]: "refresh", "CF-Connecting-IP": "198.51.100.4" }), env(fakeKv(), db), NOW, { feed, gather: gathered });
  assert.equal(res.status, 200, await res.clone().text());
  const audit = batches.flat().find((s) => /INSERT INTO audit_log/.test(s.sql));
  assert.equal(JSON.parse(String(audit?.params[4])).source_address, "198.51.100.4");
});

test("PLANT: a second refresh inside two minutes is refused with 429 and a Retry-After", async () => {
  const kv = fakeKv({ seed: { [OPS_REFRESH_KEY]: new Date(NOW.getTime() - 30_000).toISOString() } });
  const res = await handleOpsRefresh(await refreshRequest(), env(kv), NOW, { feed, gather: gathered });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "90");
  assert.deepEqual(kv.puts, [], "a refused refresh ran or stamped");
});

test("PLANT: a rate limit that cannot be read or written refuses with 503, failing closed", async () => {
  for (const opts of [{ failGet: true }, { failPut: true }]) {
    const kv = fakeKv(opts);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    let res: Response;
    try {
      res = await handleOpsRefresh(await refreshRequest(), env(kv), NOW, { feed, gather: gathered });
    } finally {
      console.error = original;
    }
    assert.equal(res.status, 503, JSON.stringify(opts));
    assert.match(await res.text(), /no pass was run/);
    assert.equal(kv.store.get(WATCHER_LAST_KEY), undefined, "a pass ran without a rate limit");
    assert.equal(errors.length, 1);
  }
});
