import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { adminAgentForEmail, legacyAgent, type Agent } from "../src/agents.ts";
import { CF_MAX_PAGES } from "../src/ops-cloudflare.ts";
import { CF_PERMISSION, readCloudflareConfig } from "../src/ops-cloudflare-config.ts";
import { buildServer } from "../src/server.ts";
import { fakeEnv, fakeKv, withFetch } from "./fakes.ts";

// The cloudflare_config tool's reads (src/ops-cloudflare-config.ts): Access apps and
// policies, Email Routing rules and addresses. What matters is what does NOT come
// back: every reader copies named fields, so a secret Cloudflare keeps beside the
// settings (an Access for SaaS client secret, a SCIM credential, an aud tag) never
// reaches the caller.

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "sample-token-0000";
const CREDS = { CF_OPS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT };
const ACCT = `/client/v4/accounts/${ACCOUNT}`;

// Planted secrets. Each is unique so a leak is found by value anywhere in the output.
const CLIENT_SECRET = "planted-saas-client-secret-7f3a";
const SCIM_TOKEN = "planted-scim-bearer-token-91c2";
const SCIM_PASSWORD = "planted-scim-password-44d0";
const SCIM_CLIENT_SECRET = "planted-scim-client-secret-a8e1";
const AUD = "planted-aud-tag-5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b";

// Cloudflare as the list endpoints answer: each path serves a list of pages, and the
// page asked for (the page query parameter) picks one. Every call is recorded.
type Page = { status?: number; body: unknown };
interface Call {
  path: string;
  params: Record<string, string>;
  bearer: boolean;
  signal: boolean;
}
function cloudflare(routes: Record<string, Page[]>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      path: u.pathname,
      params: Object.fromEntries(u.searchParams),
      bearer: headers.Authorization === `Bearer ${TOKEN}`,
      signal: init?.signal instanceof AbortSignal,
    });
    const pages = routes[u.pathname];
    if (!pages) throw new Error(`connect failed for ${u.pathname}`);
    const page = pages[Number(u.searchParams.get("page") ?? "1") - 1];
    if (!page) throw new Error(`no page ${u.searchParams.get("page")} for ${u.pathname}`);
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
  };
  return { impl, calls };
}
const listPage = (result: unknown[], page = 1, total_pages = 1): Page => ({
  body: { success: true, errors: [], messages: [], result, result_info: { page, per_page: 50, count: result.length, total_count: result.length, total_pages } },
});
const refused = (message = "Authentication error"): Page => ({ status: 403, body: { success: false, errors: [{ code: 10000, message }], messages: [], result: null } });

// A self-hosted app and an Access for SaaS app with SCIM, as Cloudflare returns them,
// carrying every secret-bearing field.
const SELF_HOSTED = {
  id: "app-1",
  name: "Sample admin",
  domain: "admin.example.com",
  type: "self_hosted",
  aud: AUD,
  self_hosted_domains: ["admin.example.com"],
  destinations: [
    { type: "public", uri: "admin.example.com/portal" },
    { type: "private", hostname: "internal.example.com", cidr: "10.0.0.0/8" },
  ],
  policies: [{ id: "pol-1", name: "Admins", decision: "allow", precedence: 1, include: [{ email: { email: "admin@example.com" } }] }],
  session_duration: "24h",
  cors_headers: { allowed_origins: ["https://example.com"] },
};
const SAAS = {
  id: "app-2",
  name: "Sample SaaS",
  domain: "sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/app-2",
  type: "saas",
  aud: AUD,
  saas_app: { auth_type: "oidc", client_id: "sample-client-id", client_secret: CLIENT_SECRET, redirect_uris: ["https://example.com/callback"] },
  scim_config: {
    enabled: true,
    remote_uri: "https://scim.example.com",
    authentication: { scheme: "oauth2", client_id: "scim-client", client_secret: SCIM_CLIENT_SECRET, token: SCIM_TOKEN, password: SCIM_PASSWORD },
  },
  policies: [{ name: "Everyone at example.com", decision: "allow" }],
};

const read = (action: Parameters<typeof readCloudflareConfig>[1], cf: ReturnType<typeof cloudflare>, zone?: string, env: Record<string, string> = CREDS) =>
  readCloudflareConfig(env, action, zone, cf.impl);

// access_apps

test("access_apps returns each app's allowlisted fields and nothing else", async () => {
  const cf = cloudflare({ [`${ACCT}/access/apps`]: [listPage([SELF_HOSTED, SAAS])] });
  const out = await read("access_apps", cf);
  assert.deepEqual(out, {
    action: "access_apps",
    count: 2,
    apps: [
      {
        id: "app-1",
        name: "Sample admin",
        domain: "admin.example.com",
        type: "self_hosted",
        self_hosted_domains: ["admin.example.com"],
        destinations: [
          { type: "public", uri: "admin.example.com/portal", hostname: null },
          { type: "private", uri: null, hostname: "internal.example.com" },
        ],
        policies: [{ name: "Admins", decision: "allow" }],
      },
      {
        id: "app-2",
        name: "Sample SaaS",
        domain: "sample.cloudflareaccess.com/cdn-cgi/access/sso/oidc/app-2",
        type: "saas",
        self_hosted_domains: [],
        destinations: [],
        policies: [{ name: "Everyone at example.com", decision: "allow" }],
      },
    ],
  });
  assert.equal(cf.calls.length, 1);
  assert.equal(cf.calls[0].bearer, true, "the read did not carry the token");
  assert.equal(cf.calls[0].signal, true, "the read carried no timeout");
});

test("PLANT: a client_secret in an Access app never reaches the caller", async () => {
  const cf = cloudflare({ [`${ACCT}/access/apps`]: [listPage([SAAS])] });
  const text = JSON.stringify(await read("access_apps", cf));
  assert.ok(!text.includes(CLIENT_SECRET), "the SaaS app's client_secret reached the caller");
  assert.ok(!/saas_app|client_secret|client_id/.test(text), `a saas_app field reached the caller: ${text}`);
  assert.ok(!text.includes(AUD), "the app's aud tag reached the caller");
});

test("PLANT: a SCIM token, password or client secret in an Access app never reaches the caller", async () => {
  const cf = cloudflare({ [`${ACCT}/access/apps`]: [listPage([SAAS])] });
  const text = JSON.stringify(await read("access_apps", cf));
  for (const secret of [SCIM_TOKEN, SCIM_PASSWORD, SCIM_CLIENT_SECRET]) assert.ok(!text.includes(secret), `${secret} reached the caller`);
  assert.ok(!/scim_config|authentication|remote_uri/.test(text), `a scim_config field reached the caller: ${text}`);
});

test("PLANT: a secret Cloudflare adds under a new field name is dropped, because nothing passes through whole", async () => {
  const cf = cloudflare({ [`${ACCT}/access/apps`]: [listPage([{ ...SELF_HOSTED, future_secret: CLIENT_SECRET, policies: [{ name: "p", decision: "allow", secret: CLIENT_SECRET }] }])] });
  const text = JSON.stringify(await read("access_apps", cf));
  assert.ok(!text.includes(CLIENT_SECRET), "an unlisted field reached the caller");
});

// access_policies

test("access_policies returns rule types, with a value only for email, email_domain, group and service_token", async () => {
  const policy = {
    id: "pol-1",
    name: "Admins",
    decision: "allow",
    reusable: true,
    app_count: 2,
    include: [{ email: { email: "admin@example.com" } }, { email_domain: { domain: "example.com" } }, { group: { id: "group-1" } }],
    exclude: [{ ip: { ip: "192.0.2.0/24" } }],
    require: [{ service_token: { token_id: "token-id-1", client_secret: CLIENT_SECRET } }, { any_valid_service_token: {} }, { everyone: {} }],
  };
  const cf = cloudflare({ [`${ACCT}/access/policies`]: [listPage([policy])] });
  const out = await read("access_policies", cf);
  assert.deepEqual(out, {
    action: "access_policies",
    count: 1,
    policies: [
      {
        id: "pol-1",
        name: "Admins",
        decision: "allow",
        include: [
          { type: "email", value: "admin@example.com" },
          { type: "email_domain", value: "example.com" },
          { type: "group", value: "group-1" },
        ],
        exclude: [{ type: "ip" }],
        require: [{ type: "service_token", value: "token-id-1" }, { type: "any_valid_service_token" }, { type: "everyone" }],
      },
    ],
  });
  assert.ok(!JSON.stringify(out).includes(CLIENT_SECRET), "a service_token rule passed more than its token_id");
});

// paging

test("a list follows result_info.total_pages and asks for every page with the same per_page", async () => {
  const cf = cloudflare({
    [`${ACCT}/access/policies`]: [
      listPage([{ id: "a", name: "A", decision: "allow" }], 1, 3),
      listPage([{ id: "b", name: "B", decision: "deny" }], 2, 3),
      listPage([{ id: "c", name: "C", decision: "bypass" }], 3, 3),
    ],
  });
  const out = await read("access_policies", cf);
  assert.equal(out.action, "access_policies");
  assert.deepEqual(
    out.action === "access_policies" ? out.policies.map((p) => p.id) : [],
    ["a", "b", "c"]
  );
  assert.deepEqual(
    cf.calls.map((c) => [c.params.page, c.params.per_page]),
    [
      ["1", "50"],
      ["2", "50"],
      ["3", "50"],
    ]
  );
});

test("a list longer than CF_MAX_PAGES fails with the count rather than answering with part of it", async () => {
  const total = CF_MAX_PAGES + 1;
  const pages = Array.from({ length: total }, (_, i) => listPage([{ email: `a${i}@example.com`, verified: null }], i + 1, total));
  const cf = cloudflare({ [`${ACCT}/email/routing/addresses`]: pages });
  await assert.rejects(read("email_addresses", cf), new RegExp(`has ${total} pages of 50, more than the ${CF_MAX_PAGES}`));
  assert.equal(cf.calls.length, CF_MAX_PAGES);
});

// email_rules

const ZONES = [
  { id: "zone-1", name: "example.com", status: "active", account: { id: ACCOUNT } },
  { id: "zone-2", name: "example.org", status: "active", account: { id: ACCOUNT } },
];
const RULE = {
  id: "rule-1",
  tag: "rule-tag",
  name: "Forward hello",
  enabled: true,
  priority: 0,
  source: "api",
  matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
  actions: [{ type: "forward", value: ["owner@example.net"] }],
};
const CATCH_ALL = { id: "rule-2", name: "Drop the rest", enabled: false, priority: 10, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };

test("email_rules reads every zone in the account and returns each rule's allowlisted fields", async () => {
  const cf = cloudflare({
    "/client/v4/zones": [listPage(ZONES)],
    "/client/v4/zones/zone-1/email/routing/rules": [listPage([RULE, CATCH_ALL])],
    "/client/v4/zones/zone-2/email/routing/rules": [listPage([])],
  });
  const out = await read("email_rules", cf);
  assert.deepEqual(out, {
    action: "email_rules",
    zones: [
      {
        zone: "example.com",
        count: 2,
        rules: [
          {
            name: "Forward hello",
            enabled: true,
            priority: 0,
            matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
            actions: [{ type: "forward", value: ["owner@example.net"] }],
          },
          { name: "Drop the rest", enabled: false, priority: 10, matchers: [{ type: "all", field: null, value: null }], actions: [{ type: "drop", value: [] }] },
        ],
      },
      { zone: "example.org", count: 0, rules: [] },
    ],
  });
  assert.equal(cf.calls[0].params["account.id"], ACCOUNT, "the zones list was not narrowed to the configured account");
  assert.equal(cf.calls[0].params.name, undefined);
});

test("email_rules with a zone reads that zone only, and a zone the token cannot list fails", async () => {
  const one = cloudflare({
    "/client/v4/zones": [listPage([ZONES[0]])],
    "/client/v4/zones/zone-1/email/routing/rules": [listPage([RULE])],
  });
  const out = await read("email_rules", one, "example.com");
  assert.equal(one.calls[0].params.name, "example.com");
  assert.deepEqual(out.action === "email_rules" ? out.zones.map((z) => z.zone) : [], ["example.com"]);
  assert.deepEqual(
    one.calls.map((c) => c.path),
    ["/client/v4/zones", "/client/v4/zones/zone-1/email/routing/rules"]
  );

  const none = cloudflare({ "/client/v4/zones": [listPage([])] });
  await assert.rejects(read("email_rules", none, "missing.example.com"), /no zone named missing\.example\.com in the account CF_OPS_TOKEN can list/);
});

// email_addresses

test("email_addresses returns each address and a verified boolean, never the timestamps or ids", async () => {
  const cf = cloudflare({
    [`${ACCT}/email/routing/addresses`]: [
      listPage([
        { id: "addr-1", tag: "addr-tag", email: "owner@example.net", verified: "2026-09-01T00:00:00Z", created: "2026-08-01T00:00:00Z", modified: "2026-09-01T00:00:00Z" },
        { id: "addr-2", tag: "addr-tag-2", email: "new@example.net", verified: null, created: "2026-09-20T00:00:00Z", modified: "2026-09-20T00:00:00Z" },
      ]),
    ],
  });
  assert.deepEqual(await read("email_addresses", cf), {
    action: "email_addresses",
    count: 2,
    addresses: [
      { email: "owner@example.net", verified: true },
      { email: "new@example.net", verified: false },
    ],
  });
});

// failures

test("a 403 names the permission CF_OPS_TOKEN lacks, for every action", async () => {
  const cases: Array<[Parameters<typeof readCloudflareConfig>[1], Record<string, Page[]>, string]> = [
    ["access_apps", { [`${ACCT}/access/apps`]: [refused()] }, CF_PERMISSION.access],
    ["access_policies", { [`${ACCT}/access/policies`]: [refused()] }, CF_PERMISSION.access],
    ["email_rules", { "/client/v4/zones": [refused()] }, CF_PERMISSION.zones],
    ["email_rules", { "/client/v4/zones": [listPage([ZONES[0]])], "/client/v4/zones/zone-1/email/routing/rules": [refused()] }, CF_PERMISSION.rules],
    ["email_addresses", { [`${ACCT}/email/routing/addresses`]: [refused()] }, CF_PERMISSION.addresses],
  ];
  for (const [action, routes, permission] of cases) {
    const err = await read(action, cloudflare(routes)).then(
      () => assert.fail(`${action} answered through a 403`),
      (e: Error) => e
    );
    assert.ok(err.message.includes(`CF_OPS_TOKEN lacks ${permission}`), `${action}: ${err.message}`);
    assert.match(err.message, /refused with 403/);
    assert.match(err.message, /Authentication error/, "Cloudflare's own message was dropped");
    assert.ok(!err.message.includes(TOKEN), "the token reached an error message");
  }
});

test("any other failure keeps Cloudflare's message and is not reported as a missing permission", async () => {
  const cf = cloudflare({ [`${ACCT}/access/apps`]: [{ status: 500, body: { success: false, errors: [{ code: 1, message: "internal error" }], result: null } }] });
  await assert.rejects(read("access_apps", cf), (e: Error) => /answered 500: internal error/.test(e.message) && !/lacks/.test(e.message));
});

test("with no token or no account, the read says exactly what is unset and fetches nothing", async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{}, /CF_OPS_TOKEN is not set; neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set/],
    [{ CF_ACCOUNT_ID: ACCOUNT }, /not configured: CF_OPS_TOKEN is not set\.$/],
    [{ CF_OPS_TOKEN: TOKEN }, /not configured: neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set\.$/],
  ];
  for (const [env, reason] of cases) {
    const cf = cloudflare({});
    await assert.rejects(read("access_apps", cf, undefined, env), reason);
    assert.equal(cf.calls.length, 0, "a read with no credentials still called Cloudflare");
  }
});

// the tool

interface ToolResult {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callTool(caller: Agent, args: Record<string, unknown>, env: Record<string, unknown> = CREDS): Promise<ToolResult> {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv, ...env }), caller);
  const client = new Client({ name: "cloudflare-config", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: "cloudflare_config", arguments: args })) as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

test("END TO END: the admin reads Access apps through the tool, with no secret in the answer", async () => {
  await withFetch({ [`GET ${ACCT}/access/apps`]: { body: listPage([SELF_HOSTED, SAAS]).body } }, async (calls) => {
    const result = await callTool(adminAgentForEmail("admin@example.com"), { action: "access_apps" });
    assert.notEqual(result.isError, true, result.content[0].text);
    const text = result.content[0].text;
    assert.equal((JSON.parse(text) as { count: number }).count, 2);
    for (const secret of [CLIENT_SECRET, SCIM_TOKEN, SCIM_PASSWORD, SCIM_CLIENT_SECRET, AUD, TOKEN]) assert.ok(!text.includes(secret), `${secret} reached the caller`);
    assert.equal(calls.length, 1);
  });
});

test("END TO END: a driver with the write grant is refused as admin only, before Cloudflare is called", async () => {
  const driver: Agent = { ...legacyAgent("write", "agent:sample-driver"), admin: false };
  await withFetch({}, async (calls) => {
    const result = await callTool(driver, { action: "access_apps" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /'cloudflare_config\.access_apps' is admin only/);
    assert.equal(calls.length, 0, "the handler ran for a refused caller");
  });
});

test("the tool refuses a zone on any action but email_rules, and answers a missing token as an error naming it", async () => {
  const admin = adminAgentForEmail("admin@example.com");
  await withFetch({}, async (calls) => {
    const zoned = await callTool(admin, { action: "access_apps", zone: "example.com" });
    assert.equal(zoned.isError, true);
    assert.match(zoned.content[0].text, /zone applies to email_rules only/);
    const unset = await callTool(admin, { action: "email_addresses" }, {});
    assert.equal(unset.isError, true);
    assert.match(unset.content[0].text, /CF_OPS_TOKEN is not set/);
    assert.equal(calls.length, 0);
  });
});

test("the tool requires an action: an omitted one is a schema error, never a default read", async () => {
  await withFetch({}, async (calls) => {
    // The SDK answers a schema failure either as an error result or by rejecting the
    // call, depending on its version. Both refuse; neither may reach Cloudflare.
    const refusedCall = await callTool(adminAgentForEmail("admin@example.com"), {}).then(
      (r) => r.isError === true,
      () => true
    );
    assert.equal(refusedCall, true, "a call with no action was answered");
    assert.equal(calls.length, 0);
  });
});
