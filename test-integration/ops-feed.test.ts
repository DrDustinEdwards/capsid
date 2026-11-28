import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { portalSessionCookie } from "../src/portal-auth";
import type { Env } from "../src/env";
import { APP_ROSTER } from "../src/roster";
import { OPS_FEED_PATH, OPS_FEED_READS, OPS_REFRESH_PATH, opsFeed } from "../src/ops-feed";
import type { OpsFeed } from "../src/ops-types/feed";

// The Watch Floor feed against a real D1 and KV: which rows each list keeps, and how
// many reads one request costs (src/ops-feed.ts states the count; this counts).

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-cookie-key";
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const iso = (ms: number) => ago(ms).toISOString();
const HOUR = 3_600_000;

async function seedFinding(fingerprint: string, state = "open") {
  await env.DB.prepare(
    `INSERT INTO watcher_findings (fingerprint, namespace, title, state, first_seen_at, last_seen_at, seen_count, updated_at)
     VALUES (?1, 'sample', ?2, ?3, ?4, ?4, 1, ?4)`,
  )
    .bind(fingerprint, `Watcher: a finding [${fingerprint}]`, state, iso(HOUR))
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watcher_findings").run();
  await seedFinding("ci-red-abc1234");
  await seedFinding("site-down-sample", "cleared");
});

function counted(): { env: Env; reads: { d1: string[]; kv: string[] } } {
  const reads = { d1: [] as string[], kv: [] as string[] };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare")
        return (sql: string) => (
          reads.d1.push(sql.replace(/\s+/g, " ").slice(0, 60)),
          target.prepare(sql)
        );
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const kv = new Proxy(env.APP_KV, {
    get(target, prop) {
      if (prop === "get") return (key: string) => (reads.kv.push(key), target.get(key));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...(env as unknown as Env), DB: db, APP_KV: kv }, reads };
}

describe("the feed against real D1", () => {
  it("PLANT: one feed costs the reads src/ops-feed.ts states, and no more", async () => {
    const { env: e, reads } = counted();
    await opsFeed(e, NOW);
    expect(reads.d1.length, `D1 statements:\n${reads.d1.join("\n")}`).toBe(OPS_FEED_READS.d1);
    expect(reads.kv.length, `KV gets: ${reads.kv.join(", ")}`).toBe(OPS_FEED_READS.kv);
    expect(reads.kv.filter((key) => APP_ROSTER.some((ns) => key.endsWith(`:${ns}`)))).toEqual([]);
    // The count does not grow with the data: more findings, the same reads.
    for (let i = 0; i < 6; i++) await seedFinding(`ci-red-${i}000000`);
    const again = counted();
    await opsFeed(again.env, NOW);
    expect(again.reads.d1.length).toBe(OPS_FEED_READS.d1);
  });

  it("reports the store's size from one small read's meta, against the 10 GB cap", async () => {
    // The PLANT above counts every statement, so a size read of its own would fail it.
    const feed = await opsFeed(env as unknown as Env, NOW);
    expect(typeof feed.live.store.size_bytes, "real D1 reports meta.size_after").toBe("number");
    expect(feed.live.store.size_bytes!).toBeGreaterThan(0);
    expect(feed.live.store.cap_bytes).toBe(10 * 1024 ** 3);
  });

  it("lists the open findings and leaves out a cleared one", async () => {
    const feed = await opsFeed(env as unknown as Env, NOW);
    expect(feed.live.findings.map((f) => f.fingerprint)).toEqual(["ci-red-abc1234"]);
    expect(feed.live.findings[0].headline).toBe("a finding");
  });
});

async function signedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = (
    await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())
  ).split(";")[0];
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }) as never,
    { ...env, COOKIE_ENCRYPTION_KEY: SECRET } as never,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

describe("the feed's routes through the Worker", () => {
  it("serves a signed-in administrator the feed, uncached", async () => {
    const response = await signedFetch(OPS_FEED_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const feed = (await response.json()) as OpsFeed;
    expect(feed.live.findings.length).toBe(1);
    // No Portal CSRF cookie on the request, so one is minted and the body carries it.
    expect(response.headers.get("Set-Cookie") ?? "").toContain(`capsid_portal_csrf=${feed.csrf};`);
  });

  it("refuses a bearer with 403 and sends an anonymous caller to sign in", async () => {
    for (const [path, method] of [
      [OPS_FEED_PATH, "GET"],
      [OPS_REFRESH_PATH, "POST"],
    ] as const) {
      const bearer = await SELF.fetch(`${ORIGIN}${path}`, {
        method,
        headers: { Authorization: "Bearer capsid_agent_x", "X-Capsid-Ops": "refresh" },
      });
      expect(bearer.status, path).toBe(403);
      const anonymous = await SELF.fetch(`${ORIGIN}${path}`, {
        method,
        headers: { "X-Capsid-Ops": "refresh" },
        redirect: "manual",
      });
      expect(anonymous.status, path).toBe(302);
    }
  });

  it("refuses a signed-in refresh without the same-origin header, before any pass", async () => {
    const response = await signedFetch(OPS_REFRESH_PATH, { method: "POST" });
    expect(response.status).toBe(403);
    expect(await env.APP_KV.get("ops:refresh:last")).toBeNull();
  });
});
