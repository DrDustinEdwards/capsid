import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_CSP, CONSOLE_PATH, consoleData, handleConsole, renderConsole } from "../src/console.ts";
import { consoleSessionCookie } from "../src/console-auth.ts";
import { BACKUP_LAST_OK_KEY } from "../src/health.ts";
import { BUDGET_KEY, MODE_KEY, ROSTER } from "../src/improve-schema.ts";
import { fakeD1, fakeKv } from "./fakes.ts";

// The route and the shell. Three callers and three answers: the admin session
// renders, a browser with no session is sent to GitHub, and a bearer token is refused
// outright rather than redirected to a login page it cannot follow.

const SECRET = "console-test-cookie-secret";

function env(overrides: Record<string, unknown> = {}) {
  const kv = fakeKv();
  const oauthKv = fakeKv();
  return {
    DB: fakeD1().db,
    APP_KV: kv.kv,
    OAUTH_KV: oauthKv.kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    BUILD_SHA: "abc1234",
    ...overrides,
  } as never;
}

function get(headers: Record<string, string> = {}): Request {
  return new Request(`https://capsid.example${CONSOLE_PATH}`, { headers });
}

test("a bearer token is REFUSED with 403, not redirected to a login it cannot follow", async () => {
  const res = await handleConsole(get({ Authorization: "Bearer capsid_deadbeef" }), env());
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /operator key|agent key/i, `the refusal should name what was presented: ${body}`);
  assert.match(body, /admin/i, "the refusal should say what the console does admit");
});

test("an anonymous browser is sent to GitHub to sign in", async () => {
  const res = await handleConsole(get(), env());
  assert.equal(res.status, 302);
  const location = res.headers.get("Location") ?? "";
  assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(location, /redirect_uri=[^&]*%2Fconsole%2Fcallback/);
  // The state cookie is what binds the callback to this browser.
  assert.match(res.headers.get("Set-Cookie") ?? "", /HttpOnly/);
});

test("the admin session renders the page, with the strict CSP and no external references", async () => {
  const cookie = await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, new Date());
  const res = await handleConsole(get({ Cookie: cookie.split(";")[0] }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
  assert.equal(res.headers.get("Content-Security-Policy"), CONSOLE_CSP);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  // Self-contained: no script tags at all, and nothing fetched from another origin.
  assert.doesNotMatch(html, /<script/i, "the console must carry no scripts");
  assert.doesNotMatch(html, /https?:\/\/(?!capsid\.example)/i, "the console must reference no external origin");
});

test("the CSP is at least as strict as the consent dialog's", () => {
  assert.match(CONSOLE_CSP, /default-src 'none'/);
  assert.match(CONSOLE_CSP, /base-uri 'none'/);
  assert.match(CONSOLE_CSP, /frame-ancestors 'none'/);
  // The console's forms post back to the console only, so it can be stricter than
  // /authorize, whose form starts a redirect chain out to a client.
  assert.match(CONSOLE_CSP, /form-action 'self'/);
  assert.doesNotMatch(CONSOLE_CSP, /script-src/, "no script source is allowed, not even 'self'");
});

test("the header carries the live sha, the schema version, the backup age, the budget and the mode", async () => {
  // Every value is seeded to something the defaults would not produce.
  const cookie = await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, new Date());
  const seeded = env({
    DB: fakeD1({ migrations: ["0001_init.sql", "0042_seeded_newest.sql"] }).db,
    APP_KV: fakeKv({
      seed: {
        [BACKUP_LAST_OK_KEY]: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        [MODE_KEY]: "api",
        [BUDGET_KEY]: JSON.stringify({ actions_minutes_month: 1234, model_usd_month: 77 }),
      },
    }).kv,
  });
  const res = await handleConsole(get({ Cookie: cookie.split(";")[0] }), seeded);
  assert.equal(res.status, 200);
  const html = await res.text();
  const factValue = (key: string) => {
    const m = new RegExp(`<span class="k">${key}</span><span class="v[^"]*">([^<]*)</span>`).exec(html);
    assert.ok(m, `the header has no '${key}' fact`);
    return m[1];
  };
  assert.equal(factValue("sha"), "abc1234");
  assert.equal(factValue("schema version"), "0042_seeded_newest.sql");
  assert.equal(factValue("backup age"), "5h");
  assert.equal(factValue("improve mode"), "api");
  assert.match(factValue("budget: ci minutes"), / of 1234$/);
  assert.match(factValue("budget: model usd"), / of 77$/);
});

test("the shell renders with ZERO namespaces rather than throwing on an empty roster", () => {
  const html = renderConsole({
    generated: "2026-09-11T14:00:00.000Z",
    viewer: "DrDustinEdwards",
    health: {
      status: "ok",
      sha: "abc1234",
      dirty: false,
      builtAt: "2026-09-11T13:00:00.000Z",
      schema_version: "0009_jobs_required_scopes.sql",
      store: { d1: "ok", fts: "ok" },
      bindings: { media: "ok", app_kv: "ok" },
      backup: { last_ok: "2026-09-11T09:00:00.000Z", age_hours: 5 },
    },
    improve: {
      mode: "subscription",
      mode_note: null,
      cost_note: "estimate",
      budget: {
        month: "2026-09",
        caps: { actions_minutes_month: 2000, model_usd_month: 50 },
        spend: { ci_minutes: 10, cost_usd: 1.5 },
        exceeded: false,
        reason: null,
      },
      protected_paths: [],
      policies: { gates: { version: "1", enabled: true }, auto_merge: { version: "3", enabled: true } },
      agents: [],
      namespaces: [],
    },
    activity: [],
    activity_filter: { namespace: null, actor: null },
    watcher_last: null,
    agents: [],
  });
  assert.match(html, /No namespaces on the improve roster/);
  assert.match(html, /0009_jobs_required_scopes\.sql/);
  assert.match(html, /5h/, "the backup age should render");
});

test("consoleData reads the header numbers through healthReport and improveStatus", async () => {
  const kv = fakeKv({
    seed: {
      [MODE_KEY]: "subscription",
      [BUDGET_KEY]: JSON.stringify({ actions_minutes_month: 321, model_usd_month: 9 }),
    },
  });
  const data = await consoleData(
    env({ BUILD_SHA: "feedface", DB: fakeD1({ migrations: ["0007_seeded.sql"] }).db, APP_KV: kv.kv }),
    "DrDustinEdwards",
    new Date("2026-09-11T14:00:00Z")
  );
  assert.equal(data.viewer, "DrDustinEdwards");
  assert.equal(data.health.sha, "feedface");
  assert.equal(data.health.schema_version, "0007_seeded.sql");
  assert.equal(data.generated, "2026-09-11T14:00:00.000Z");
  // The roster, straight from improveStatus rather than a list this module keeps.
  assert.ok(ROSTER.length > 0);
  assert.deepEqual(data.improve.namespaces.map((n) => n.namespace).sort(), [...ROSTER].sort());
  assert.equal(data.improve.mode, "subscription");
  assert.equal(data.improve.budget.caps.actions_minutes_month, 321);
  assert.equal(data.improve.budget.caps.model_usd_month, 9);
});
