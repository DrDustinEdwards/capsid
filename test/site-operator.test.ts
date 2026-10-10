import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allowedTools, callOperator, parseOperator, repairToolRefusal, toolRefusal } from "../src/site-operator.ts";
import { failingChecks, repairPlan } from "../src/site-watch.ts";
import { limitRefusal, AUTO_PER_DAY } from "../src/site-repair.ts";
import { healthChecks, statusFields } from "../src/site-convergence.ts";
import { secretPresence } from "../src/secret-presence.ts";
import { readSecretNames } from "../src/ops-cloudflare.ts";
import type { Env } from "../src/env.ts";
import type { SiteOperator } from "../src/ops-types.ts";

// A site's operator API (job_09e5f6cbf782): the configuration's rules, the two allowlists,
// the one call, the watcher's repair plan and rate limit, and the convergence view's
// parsing. The writes, the control and the watcher step run against real D1 and KV in
// test-integration/site-repair.test.ts.

const TOKEN = "sample-operator-token-for-tests-only-0000";
const OPERATOR: SiteOperator = {
  path: "/api/operator",
  auth_var: "SAMPLE_OPERATOR_TOKEN",
  repairs: { "content-drift": "sync_posts", "pages-drift": "sync_pages", "ask-index-drift": "sync_ask" },
  weekly: ["refresh_citations"],
  secrets: ["GITHUB_TOKEN"],
};
const SITE = { origin: "https://sample.example.com", operator: OPERATOR };
const ENV = { SAMPLE_OPERATOR_TOKEN: TOKEN } as unknown as Env;

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, impl };
}

test("the migration's dustinedwards configuration passes the same rules an edit passes, and names no backup_media", () => {
  const sql = readFileSync(new URL("../migrations/0035_ops_sites_operator.sql", import.meta.url), "utf8");
  const json = /SET operator = '([^']+)'/.exec(sql)?.[1];
  assert.ok(json, "the migration seeds no configuration");
  const parsed = parseOperator(json);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.refusal);
  assert.equal(parsed.operator.auth_var, "DUSTINEDWARDS_OPERATOR_TOKEN");
  assert.equal(Object.keys(parsed.operator.repairs).length, 13);
  assert.ok(!allowedTools(parsed.operator).includes("backup_media"));
  assert.deepEqual(parsed.operator.weekly, ["refresh_citations"]);
});

test("PLANT: a configuration naming backup_media, a write tool or sync_status as a repair is refused whole", () => {
  const base = { path: "/api/operator", auth_var: "SAMPLE_OPERATOR_TOKEN" };
  for (const [label, extra, pattern] of [
    ["backup_media as a repair", { repairs: { "media-backup-drift": "backup_media" } }, /backup_media is not a repair/],
    ["backup_media weekly", { weekly: ["backup_media"] }, /backup_media is not a repair/],
    ["a write tool", { repairs: { "content-drift": "save_post" } }, /'save_post' is not a repair/],
    ["sync_status as a repair", { repairs: { "content-drift": "sync_status" } }, /sync_status is a read/],
    ["a token that is not an operator token", { auth_var: "GITHUB_APP_PRIVATE_KEY" }, /must name a Capsid Worker secret ending in _OPERATOR_TOKEN/],
    ["a path off the origin", { path: "https://elsewhere.example.com/x" }, /path must be a path/],
    ["an unknown key", { url: "x" }, /'url' is not one of them/],
  ] as const) {
    const got = parseOperator(JSON.stringify({ ...base, ...extra }));
    assert.equal(got.ok, false, `${label} was accepted`);
    if (!got.ok) assert.match(got.refusal, pattern, label);
  }
  assert.equal(repairToolRefusal("sync_media"), null);
  assert.equal(repairToolRefusal("refresh_citations"), null);
});

test("PLANT: backup_media and an unknown tool are refused at the Worker before any request, even when a stored configuration names them", async () => {
  // A row that bypassed the edit rules: the ceiling is checked again before every call.
  const tampered: SiteOperator = { ...OPERATOR, repairs: { ...OPERATOR.repairs, "media-backup-drift": "backup_media", "x-drift": "delete_post" } };
  const { calls, impl } = recorder(() => Response.json({ ok: true, data: { converged: true } }));
  for (const tool of ["backup_media", "delete_post", "sync_unlisted"]) {
    const got = await callOperator(ENV, { origin: SITE.origin, operator: tampered }, tool, impl);
    assert.equal(got.ok, false, `${tool} was called`);
    assert.match(got.error ?? "", /refused by Capsid before any request/);
  }
  assert.equal(toolRefusal(tampered, "sync_unlisted"), "sync_unlisted is not in this site's allowlist (sync_posts, sync_pages, sync_ask, backup_media, delete_post, refresh_citations).");
  assert.deepEqual(calls, [], "a refused tool reached the site");
});

test("with the token unset nothing is called; with it set the call carries it to the site's own route and reads the verdict", async () => {
  const { calls, impl } = recorder((_url, init) =>
    JSON.parse(String(init.body)).tool === "sync_pages"
      ? Response.json({ ok: true, data: { repaired: 2, expected: 14, present: 14, converged: true } })
      : Response.json({ ok: false, error: "sync_posts could not apply 1 file(s)" }, { status: 422 })
  );
  const unset = await callOperator({} as Env, SITE, "sync_pages", impl);
  assert.match(unset.error ?? "", /SAMPLE_OPERATOR_TOKEN is not set, so nothing was called/);
  assert.equal(calls.length, 0);

  const ok = await callOperator(ENV, SITE, "sync_pages", impl);
  assert.deepEqual([ok.ok, ok.converged, ok.expected, ok.present, ok.data], [true, true, 14, 14, null]);
  assert.equal(calls[0].url, "https://sample.example.com/api/operator");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { tool: "sync_pages", args: {} });

  const refused = await callOperator(ENV, SITE, "sync_posts", impl);
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /answered 422: sync_posts could not apply/);
  assert.ok(!JSON.stringify(refused).includes(TOKEN), "the token reached a result");
});

test("the watcher repairs only when every failing check maps, in the configuration's order", () => {
  const body = { ok: false, checks: [{ name: "ask-index-drift", ok: false }, { name: "content-drift", ok: false }, { name: "pages-drift", ok: true }, { name: "no-ok-field" }] };
  assert.deepEqual(failingChecks(body), ["ask-index-drift", "content-drift"]);
  assert.deepEqual(repairPlan(failingChecks(body), OPERATOR), { tools: ["sync_posts", "sync_ask"] });
  const unmapped = repairPlan(["content-drift", "media-backup-drift"], OPERATOR);
  assert.ok("none" in unmapped && /media-backup-drift maps to no repair/.test(unmapped.none));
  assert.ok("none" in repairPlan([], OPERATOR));
});

test("the rate limit: two minutes for anyone, thirty for the watcher, and four watcher runs a day", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  assert.equal(limitRefusal(null, now, true), null);
  assert.match(limitRefusal({ last: ago(1), auto: [] }, now, false) ?? "", /ran 1 minute\(s\) ago/);
  assert.equal(limitRefusal({ last: ago(5), auto: [] }, now, false), null);
  assert.match(limitRefusal({ last: ago(5), auto: [] }, now, true) ?? "", /after 30 minutes/);
  const four = [ago(600), ago(400), ago(200), ago(60)];
  assert.equal(four.length, AUTO_PER_DAY);
  assert.match(limitRefusal({ last: ago(60), auto: four }, now, true) ?? "", /4 times in the last day/);
  assert.equal(limitRefusal({ last: ago(60), auto: four }, now, false), null, "a person can still run it");
  assert.equal(limitRefusal({ last: ago(60), auto: [ago(1500), ...four.slice(1)] }, now, true), null, "a run over a day old no longer counts");
});

test("the convergence view maps each check to its repair and keeps sync_status's scalars and divergences", () => {
  const checks = healthChecks({ checks: [{ name: "content-drift", ok: false, detail: "2 posts differ", expected: 42, present: 40 }, { name: "media-backup-drift", ok: true }, { bad: 1 }] }, OPERATOR);
  assert.deepEqual(checks.map((c) => [c.name, c.ok, c.repair, c.repair_refusal, c.present]), [
    ["content-drift", false, "sync_posts", null, 40],
    ["media-backup-drift", true, null, null, null],
  ]);
  assert.deepEqual(statusFields({ headSha: "abc", d1Posts: 42, askConfigured: true, nested: { x: 1 }, divergences: { known: true, list: [] } }), [
    { key: "headSha", value: "abc" },
    { key: "d1Posts", value: "42" },
    { key: "askConfigured", value: "true" },
    { key: "divergences", value: "none" },
  ]);
});

test("secret presence: each expected name set or not, then the Worker's other names, and a 403 names the permission", async () => {
  assert.deepEqual(secretPresence(["GITHUB_TOKEN", "SMOKE_TOKEN"], ["OPERATOR_TOKEN", "GITHUB_TOKEN"]), [
    { name: "GITHUB_TOKEN", set: true, expected: true },
    { name: "SMOKE_TOKEN", set: false, expected: true },
    { name: "OPERATOR_TOKEN", set: true, expected: false },
  ]);
  const listed = async () => Response.json({ success: true, errors: [], result: [{ name: "GITHUB_TOKEN", type: "secret_text", text: "never-read" }] });
  assert.deepEqual(await readSecretNames(listed, "cf-token", "acct", "sample"), ["GITHUB_TOKEN"]);
  const denied = async () => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 });
  await assert.rejects(readSecretNames(denied, "cf-token", "acct", "sample"), /CF_OPS_TOKEN lacks Account \/ Workers Scripts \/ Read/);
});
