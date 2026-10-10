import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedRedirects, DCR_LIMIT, FIXED_REDIRECTS, gateRegistration } from "../src/dcr.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// Tightened DCR (src/dcr.ts, capsid/rulings/mcp-2026-10-10.md rule 13): every redirect
// URI exact on the allowlist, a rate limit that fails closed, and nothing forwarded to
// the provider that the gate has not judged.

const NOW = new Date("2026-10-10T12:00:00Z");
const GROK = "https://grok.com/connectors/oauth/callback";
const GEMINI = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-mcp.example.com";

function register(body: unknown, ip = "203.0.113.9"): Request {
  return new Request("https://mcp.example.com/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const envWith = (kv = fakeKv().kv, extra: Record<string, unknown> = {}) => fakeEnv({ APP_KV: kv, ...extra });

test("the fixed callbacks are Grok's and ChatGPT's, and nothing else", () => {
  assert.deepEqual([...FIXED_REDIRECTS], [GROK, "https://chatgpt.com/connector_platform_oauth_redirect"]);
  assert.deepEqual([...allowedRedirects({})], [...FIXED_REDIRECTS]);
});

test("PLANT: Grok's callback registers, and the provider gets the body the gate read", async () => {
  const body = { client_name: "Grok", redirect_uris: [GROK], token_endpoint_auth_method: "none" };
  const gate = await gateRegistration(register(body), envWith(), NOW);
  assert.ok("forward" in gate, "Grok's exact callback was refused");
  assert.deepEqual(JSON.parse(await gate.forward.text()), body);
  assert.equal(gate.forward.method, "POST");
});

test("PLANT: an unlisted redirect is refused before the provider, naming it", async () => {
  for (const uri of ["https://client.example.com/callback", `${GROK}/`, `${GROK}?x=1`, "https://grok.com/connectors/oauth/callback2", "http://grok.com/connectors/oauth/callback"]) {
    const gate = await gateRegistration(register({ redirect_uris: [uri] }), envWith(), NOW);
    assert.ok("refuse" in gate, `${uri} was let through: the match is not exact`);
    assert.equal(gate.refuse.status, 400);
    const out = (await gate.refuse.json()) as { error: string; error_description: string };
    assert.equal(out.error, "invalid_redirect_uri");
    assert.ok(out.error_description.includes(uri));
  }
});

test("one unlisted redirect beside an allowed one refuses the whole registration", async () => {
  const gate = await gateRegistration(register({ redirect_uris: [GROK, "https://attacker.example.com/cb"] }), envWith(), NOW);
  assert.ok("refuse" in gate);
  assert.equal(gate.refuse.status, 400);
});

test("a body with no redirect_uris, an empty list, a non-string or non-JSON is refused", async () => {
  for (const body of [{}, { redirect_uris: [] }, { redirect_uris: [7] }, { redirect_uris: GROK }, "not json", "null"]) {
    const gate = await gateRegistration(register(body), envWith(), NOW);
    assert.ok("refuse" in gate, JSON.stringify(body));
    assert.equal(gate.refuse.status, 400);
  }
});

test("an oversized body is refused", async () => {
  const gate = await gateRegistration(register({ redirect_uris: [GROK], pad: "x".repeat(20_000) }), envWith(), NOW);
  assert.ok("refuse" in gate);
  assert.equal(gate.refuse.status, 413);
});

test("PLANT: a Gemini callback registers only once the seat lists it exactly", async () => {
  const without = await gateRegistration(register({ redirect_uris: [GEMINI] }), envWith(), NOW);
  assert.ok("refuse" in without, "a per-connector callback registered with nothing listed");
  const listed = await gateRegistration(register({ redirect_uris: [GEMINI] }), envWith(fakeKv().kv, { DCR_REDIRECT_URIS: ` ${GEMINI} ,` }), NOW);
  assert.ok("forward" in listed, "the listed Gemini callback was refused");
  const other = await gateRegistration(register({ redirect_uris: [`${GEMINI}0`] }), envWith(fakeKv().kv, { DCR_REDIRECT_URIS: GEMINI }), NOW);
  assert.ok("refuse" in other, "a listed callback admitted a longer one: the list is a pattern, not exact");
});

test("PLANT: a listed URI of the wrong shape cannot widen the list", () => {
  const allowed = allowedRedirects({ DCR_REDIRECT_URIS: "https://attacker.example.com/cb,https://oauth-redirect.googleusercontent.com/r/any-project,https://chatgpt.com/connector/oauth/abc_123" });
  assert.equal(allowed.has("https://attacker.example.com/cb"), false);
  assert.equal(allowed.has("https://oauth-redirect.googleusercontent.com/r/any-project"), false, "Google's relay forwards any /r/<id>, so only connector callbacks may be listed");
  assert.equal(allowed.has("https://chatgpt.com/connector/oauth/abc_123"), true);
});

test("PLANT: the eleventh registration in an hour from one address is refused, and others are not", async () => {
  const kv = fakeKv().kv;
  for (let i = 0; i < DCR_LIMIT.perHour; i++) {
    assert.ok("forward" in (await gateRegistration(register({ redirect_uris: [GROK] }), envWith(kv), NOW)), `registration ${i + 1} was refused`);
  }
  const over = await gateRegistration(register({ redirect_uris: [GROK] }), envWith(kv), NOW);
  assert.ok("refuse" in over);
  assert.equal(over.refuse.status, 429);
  assert.equal(over.refuse.headers.get("Retry-After"), "3600");
  const elsewhere = await gateRegistration(register({ redirect_uris: [GROK] }, "198.51.100.4"), envWith(kv), NOW);
  assert.ok("forward" in elsewhere);
});

test("PLANT: an unreadable rate limit refuses the registration", async () => {
  const gate = await gateRegistration(register({ redirect_uris: [GROK] }), envWith(fakeKv({ failGet: true }).kv), NOW);
  assert.ok("refuse" in gate, "registration failed open when the limit could not be read");
  assert.equal(gate.refuse.status, 503);
  const noKv = await gateRegistration(register({ redirect_uris: [GROK] }), fakeEnv({}), NOW);
  assert.ok("refuse" in noKv);
  assert.equal(noKv.refuse.status, 503);
});
