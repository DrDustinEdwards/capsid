import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { defaultScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, type Agent } from "../src/agents.ts";
import { STEP_UP, STEP_UP_WINDOW_MS } from "../src/scope.ts";
import { buildAdminServer } from "../src/server.ts";
import { CARREL_SCRIPT, SITE_SECRET, carrelSecretName, mintSiteKey, setSiteKey } from "../src/site-key.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// Set a site key (src/site-key.ts), served as capsid_admin_set_site_key. A new key is
// minted and set on the site's Worker, then on Carrel. Its value is never returned,
// logged or audited, on success or on failure.

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "sample-secrets-token";
const SECRETS = (script: string) => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${script}/secrets`;
const MINUTE = 60 * 1000;

interface Audit {
  actor: unknown;
  action: unknown;
  namespace: unknown;
  path: unknown;
  params: string;
}

// ops_sites answered by namespace, and audit_log INSERTs captured with their bound values.
function siteDb(opts: { script?: string | null; platform?: string; failAudit?: boolean } = {}) {
  const audits: Audit[] = [];
  const row = {
    namespace: "sample",
    name: "Sample",
    origin: "https://sample.example.com",
    health_path: null,
    platform: opts.platform ?? "cloudflare",
    script: opts.script === undefined ? "sample-site" : opts.script,
    self_probe: 0,
    revision: 1,
    updated_at: "2026-10-01 00:00:00",
    operator: null,
  };
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (!/FROM ops_sites WHERE namespace = \?1/.test(sql)) throw new Error(`unexpected read: ${sql}`);
          return params[0] === "sample" ? row : null;
        },
        run: async () => {
          if (!/^INSERT INTO audit_log/.test(sql)) throw new Error(`unexpected write: ${sql}`);
          if (opts.failAudit) throw new Error("D1_ERROR: sample audit insert failed");
          const [actor, action, namespace, path, p] = params;
          audits.push({ actor, action, namespace, path, params: String(p) });
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  };
  return { db, audits };
}

const ENV = { CF_SECRETS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT };

type Answer = { status: number; body: unknown } | "throw";
const OK: Answer = { status: 200, body: { success: true, errors: [], messages: [], result: {} } };
const DENIED: Answer = { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } };

// Cloudflare's secrets endpoint. Each PUT's secret name and value are captured, so a test
// knows the minted key and can look for it everywhere else.
function cloudflare(site: Answer, carrel: Answer) {
  const calls: Array<{ url: string; method: string; name: string; value: string; bearer: boolean }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { name: string; text: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? "GET", name: body.name, value: body.text, bearer: headers.Authorization === `Bearer ${TOKEN}` });
    const a = url === SECRETS("sample-site") ? site : url === SECRETS(CARREL_SCRIPT) ? carrel : "throw";
    if (a === "throw") throw new Error(`connect failed (sample)`);
    return new Response(JSON.stringify(a.body), { status: a.status });
  };
  return { impl, calls };
}

// Every line written to the console while fn runs.
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const sink = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  Object.assign(console, { log: sink, info: sink, warn: sink, error: sink, debug: sink });
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// carrelSecretName

test("carrelSecretName is SITE_<NAMESPACE>_KEY, upper case, dashes as underscores", () => {
  assert.equal(carrelSecretName("sample"), "SITE_SAMPLE_KEY");
  assert.equal(carrelSecretName("sample-site-two"), "SITE_SAMPLE_SITE_TWO_KEY");
  assert.equal(carrelSecretName("sample2"), "SITE_SAMPLE2_KEY");
});

test("mintSiteKey is 43 base64url characters, fresh each time", () => {
  const a = mintSiteKey();
  const b = mintSiteKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

// The value is never shown

const OUTCOMES: Array<[string, Answer, Answer]> = [
  ["both sides take it", OK, OK],
  ["the site refuses it (403)", DENIED, OK],
  ["Carrel refuses it (403)", OK, DENIED],
  ["the site gives no answer", "throw", OK],
  ["Carrel gives no answer", OK, "throw"],
  ["the site answers with no JSON", { status: 500, body: "<html>sample</html>" }, OK],
];

for (const [label, siteAnswer, carrelAnswer] of OUTCOMES) {
  test(`PLANT: the minted value is not in the return value, the audit row, or any logged line when ${label}`, async () => {
    const { db, audits } = siteDb();
    const cf = cloudflare(siteAnswer, carrelAnswer);
    const { value, lines } = await captured(() => setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl));
    assert.ok(cf.calls.length >= 1, "nothing was sent, so the absence of the value proves nothing");
    const key = cf.calls[0].value;
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, "the value sent is not a minted key");
    assert.equal(JSON.stringify(value).includes(key), false, "the minted value is in the return value");
    assert.equal(audits.length, 1, "no audit row was written");
    assert.equal(JSON.stringify(audits).includes(key), false, "the minted value is in the audit row");
    for (const line of lines) assert.equal(line.includes(key), false, `the minted value was logged: ${line}`);
    assert.equal(JSON.stringify(value).includes(TOKEN), false, "the token is in the return value");
  });
}

test("PLANT: the value stays out of the logs when the audit insert itself fails", async () => {
  const { db } = siteDb({ failAudit: true });
  const cf = cloudflare(OK, OK);
  const { value, lines } = await captured(() => setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl));
  const key = cf.calls[0].value;
  assert.ok(lines.some((l) => /AUDIT_INSERT_FAILED set_site_key sample/.test(l)), "the failed audit was not logged");
  for (const line of lines) assert.equal(line.includes(key), false, `the minted value was logged: ${line}`);
  assert.equal(JSON.stringify(value).includes(key), false);
});

// Order

test("THE INNOCENT DIRECTION: the site is set first, then Carrel, with the same value, and the answer says they match", async () => {
  const { db, audits } = siteDb();
  const cf = cloudflare(OK, OK);
  const r = await setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl);
  assert.deepEqual(cf.calls.map((c) => [c.method, c.url, c.name]), [
    ["PUT", SECRETS("sample-site"), SITE_SECRET],
    ["PUT", SECRETS(CARREL_SCRIPT), "SITE_SAMPLE_KEY"],
  ]);
  assert.equal(cf.calls[0].value, cf.calls[1].value, "the two sides were sent different keys");
  assert.ok(cf.calls.every((c) => c.bearer), "a call went without CF_SECRETS_TOKEN");
  assert.equal(r.matched, true);
  assert.equal(r.site.set, true);
  assert.equal(r.carrel.set, true);
  assert.equal(audits[0].action, "set_site_key");
  assert.equal(audits[0].actor, "access:admin@example.com");
  assert.equal(audits[0].namespace, "sample");
});

test("PLANT: when the site does not take the key, Carrel is not attempted and the answer says nothing changed", async () => {
  const { db } = siteDb();
  const cf = cloudflare(DENIED, OK);
  const r = await setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl);
  assert.deepEqual(cf.calls.map((c) => c.url), [SECRETS("sample-site")], "Carrel was called after the site refused the key");
  assert.equal(r.matched, false);
  assert.equal(r.site.set, false);
  assert.match(r.site.error ?? "", /403.*Authentication error.*Workers Scripts Edit/s);
  assert.equal(r.carrel.set, false);
  assert.match(r.carrel.error ?? "", /^not attempted/);
  assert.match(r.note, /^Nothing changed/);
});

test("when Carrel alone fails, the answer says the two sides differ and to call again", async () => {
  const { db } = siteDb();
  const cf = cloudflare(OK, DENIED);
  const r = await setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl);
  assert.equal(cf.calls.length, 2);
  assert.equal(r.matched, false);
  assert.equal(r.site.set, true);
  assert.equal(r.carrel.set, false);
  assert.match(r.note, /THE TWO SIDES DIFFER.*Call again/s);
});

// No token

test("PLANT: with CF_SECRETS_TOKEN unset, nothing is minted and nothing is fetched", async (t) => {
  const random = t.mock.method(crypto, "getRandomValues");
  for (const env of [{ CF_ACCOUNT_ID: ACCOUNT }, { CF_SECRETS_TOKEN: "   ", CF_ACCOUNT_ID: ACCOUNT }]) {
    const { db, audits } = siteDb();
    const cf = cloudflare(OK, OK);
    await assert.rejects(() => setSiteKey(fakeEnv({ DB: db, ...env }), "access:admin@example.com", "sample", cf.impl), /no key was minted: CF_SECRETS_TOKEN is not set/);
    assert.equal(cf.calls.length, 0, "a call with no token reached Cloudflare");
    assert.equal(audits.length, 0);
  }
  assert.equal(random.mock.callCount(), 0, "a key was minted with no token to set it with");
});

test("THE INNOCENT DIRECTION: with the token set, exactly one key is minted", async (t) => {
  const random = t.mock.method(crypto, "getRandomValues");
  const { db } = siteDb();
  const cf = cloudflare(OK, OK);
  await setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl);
  assert.equal(random.mock.callCount(), 1);
});

test("PLANT: a site row with no Cloudflare script mints nothing and fetches nothing", async () => {
  for (const opts of [{ script: null }, { platform: "vercel" }, { script: "bad/script" }]) {
    const { db } = siteDb(opts);
    const cf = cloudflare(OK, OK);
    await assert.rejects(() => setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample", cf.impl), /no key was minted: sample's site row names no Cloudflare Worker script/);
    assert.equal(cf.calls.length, 0);
  }
  const { db } = siteDb();
  const cf = cloudflare(OK, OK);
  await assert.rejects(() => setSiteKey(fakeEnv({ DB: db, ...ENV }), "access:admin@example.com", "sample-other", cf.impl), /no key was minted/);
  assert.equal(cf.calls.length, 0);
});

// Served: capsid_admin_set_site_key, admin only and stepped up

assert.equal(STEP_UP.capsid_admin_set_site_key, "*", "capsid_admin_set_site_key is no longer stepped up; the tests below assume it is");

function driver(): Agent {
  const scopes = defaultScopes(["sample"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

async function callAs(agent: Agent, db: unknown) {
  const server = buildAdminServer(fakeEnv({ DB: db, APP_KV: fakeKv({}).kv, ...ENV }), agent);
  const client = new Client({ name: "set-site-key", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name: "capsid_admin_set_site_key", arguments: { namespace: "sample" } })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join("\n") };
  } finally {
    await client.close();
    await server.close();
  }
}

const ROUTES = {
  [`PUT /client/v4/accounts/${ACCOUNT}/workers/scripts/sample-site/secrets`]: { body: { success: true, errors: [], result: {} } },
  [`PUT /client/v4/accounts/${ACCOUNT}/workers/scripts/${CARREL_SCRIPT}/secrets`]: { body: { success: true, errors: [], result: {} } },
};

test("PLANT: a non-admin is refused capsid_admin_set_site_key before its handler runs", async () => {
  const { db, audits } = siteDb();
  await withFetch(ROUTES, async (calls) => {
    const r = await callAs(driver(), db);
    assert.equal(r.isError, true, `a driver was not refused: ${r.text}`);
    assert.match(r.text, /^unauthorized: 'capsid_admin_set_site_key' is admin only and agent:sample-driver is not the admin/);
    assert.equal(calls.length, 0, "a refused caller reached Cloudflare");
    assert.equal(audits.length, 0);
  });
});

test("PLANT: an admin whose sign-in is older than the step-up window is refused, and nothing is set", async () => {
  const { db, audits } = siteDb();
  await withFetch(ROUTES, async (calls) => {
    const r = await callAs(adminAgentForEmail("admin@example.com", Date.now() - STEP_UP_WINDOW_MS - MINUTE), db);
    assert.equal(r.isError, true);
    assert.match(r.text, /step-up required: 'capsid_admin_set_site_key'/);
    assert.match(r.text, /Nothing was done\./);
    assert.equal(calls.length, 0, "a stale sign-in reached Cloudflare");
    assert.equal(audits.length, 0);
  });
});

test("THE INNOCENT DIRECTION: an admin signed in within the window sets the key on both sides, and the value is not in the answer", async () => {
  const { db, audits } = siteDb();
  await withFetch(ROUTES, async (calls) => {
    const r = await callAs(adminAgentForEmail("admin@example.com", Date.now() - MINUTE), db);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /"matched": ?true/);
    assert.deepEqual(calls.map((c) => c.path), [
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/sample-site/secrets`,
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${CARREL_SCRIPT}/secrets`,
    ]);
    const key = (calls[0].body as { text: string }).text;
    assert.equal(r.text.includes(key), false, "the minted value is in the tool's answer");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor, "access:admin@example.com");
  });
});

