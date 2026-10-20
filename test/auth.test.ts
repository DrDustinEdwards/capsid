import assert from "node:assert/strict";
import { test } from "node:test";
import { bearerToken, sha256Hex, operatorIdentity } from "../src/auth.ts";

async function grantOf(request: Request, env: { OPERATOR_KEY_HASH?: string }) {
  return (await operatorIdentity(request, env)).grant;
}

const req = (key?: string) =>
  new Request("https://capsid.example/ops/mcp", {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });

test("single write key still grants write (backwards compatible)", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("full-key") };
  assert.equal(await grantOf(req("full-key"), env), "write");
});

test("ro: entry grants read only", async () => {
  const env = { OPERATOR_KEY_HASH: `ro:${await sha256Hex("agent-key")}` };
  assert.equal(await grantOf(req("agent-key"), env), "read");
});

test("comma-separated list resolves each key to its own grant", async () => {
  const env = {
    OPERATOR_KEY_HASH: `${await sha256Hex("full-key")}, ro:${await sha256Hex("agent-key")}`,
  };
  assert.equal(await grantOf(req("full-key"), env), "write");
  assert.equal(await grantOf(req("agent-key"), env), "read");
});

test("removing a hash revokes that key without touching the others", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("full-key") };
  assert.equal(await grantOf(req("agent-key"), env), null);
  assert.equal(await grantOf(req("full-key"), env), "write");
});

test("uppercase hashes and stray whitespace in the secret still match", async () => {
  const env = {
    OPERATOR_KEY_HASH: ` ${(await sha256Hex("full-key")).toUpperCase()} ,, RO:${await sha256Hex("agent-key")} `,
  };
  assert.equal(await grantOf(req("full-key"), env), "write");
  assert.equal(await grantOf(req("agent-key"), env), "read");
});

test("missing header, non-bearer auth, or empty secret all deny", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("full-key") };
  assert.equal(await grantOf(req(), env), null);
  assert.equal(
    await grantOf(
      new Request("https://capsid.example/ops/mcp", { headers: { Authorization: "Basic abc" } }),
      env
    ),
    null
  );
  assert.equal(await grantOf(req("full-key"), { OPERATOR_KEY_HASH: "" }), null);
});

test("a raw key pasted as the secret never matches (hashes only)", async () => {
  const env = { OPERATOR_KEY_HASH: "full-key" };
  assert.equal(await grantOf(req("full-key"), env), null);
});

// Principal binding: audit_log.actor records who made a write, not a fixed literal.

function keyRequest(key: string): Request {
  return new Request("https://example.com/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });
}

test("operatorIdentity returns a fingerprint that identifies WHICH key was used", async () => {
  const writeHash = await sha256Hex("write-key");
  const roHash = await sha256Hex("agent-key");
  const env = { OPERATOR_KEY_HASH: `${writeHash},ro:${roHash}` };

  const w = await operatorIdentity(keyRequest("write-key"), env);
  const r = await operatorIdentity(keyRequest("agent-key"), env);

  assert.equal(w.grant, "write");
  assert.equal(r.grant, "read");
  assert.notEqual(w.fingerprint, r.fingerprint, "two different keys must be distinguishable");
  assert.equal(w.fingerprint, writeHash.slice(0, 12));
});

test("the fingerprint is a prefix, never the stored verifier", async () => {
  const hash = await sha256Hex("write-key");
  const { fingerprint } = await operatorIdentity(keyRequest("write-key"), { OPERATOR_KEY_HASH: hash });
  assert.equal(fingerprint?.length, 12, "12 hex chars");
  assert.notEqual(fingerprint, hash, "must NOT be the full digest that OPERATOR_KEY_HASH stores");
  assert.ok(!fingerprint!.includes("write-key"), "and obviously not the key itself");
});

test("a rejected key yields no grant and no fingerprint", async () => {
  const env = { OPERATOR_KEY_HASH: await sha256Hex("write-key") };
  const bad = await operatorIdentity(keyRequest("not-a-key"), env);
  assert.deepEqual(bad, { grant: null, fingerprint: null });
});

test("bearerToken: the scheme in any case, one token, nothing else", () => {
  const with_ = (value: string | null) =>
    bearerToken(new Request("https://example.com/", { headers: value === null ? {} : { Authorization: value } }));
  assert.equal(with_("Bearer abc"), "abc");
  assert.equal(with_("bearer abc"), "abc", "RFC 9110: the scheme is case-insensitive");
  assert.equal(with_("BEARER  abc "), "abc");
  assert.equal(with_("Bearer "), null);
  assert.equal(with_("Bearer a b"), null, "a token has no space in it");
  assert.equal(with_("Basic abc"), null);
  assert.equal(with_(null), null);
});
