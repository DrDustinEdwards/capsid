import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { adminAgent } from "../src/agents.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// One definition, imported. Conventions about the shape of src/ rather than the
// behaviour of any one module: each guard asks whether a fact is still stated once,
// and scans all of src/ rather than a list of files where a copy might appear.
//
// That the CSP report sink and the backup prune agree on the report prefix is driven
// in test-integration/csp-report.test.ts: a stored report, aged, is reaped by the cron.

// scanner-rule: quality audit 6.6 and 1.1, one definition imported everywhere
test("every secret compare goes through timingSafeEqual, in every file", () => {
  // The specific compares, still where they belong.
  const auth = sourceFiles().find((f) => f.name === "auth.ts")!.text;
  const handler = sourceFiles().find((f) => f.name === "routes.ts")!.text;
  assert.ok(auth.includes("timingSafeEqual(readonly ? entry.slice(3) : entry, hash)"));
  assert.match(handler, /timingSafeEqual\(sig, await hmacHex/);
  assert.match(handler, /timingSafeEqual\(csrfCookie, csrf\)/);
  const githubLogin = sourceFiles().find((f) => f.name === "github-login.ts")!.text;
  assert.match(githubLogin, /timingSafeEqual\(stateCookie, await sha256Hex/);

  // And no file anywhere has gone back to a short-circuiting compare of a secret.
  // Matched by shape rather than by the spellings that exist today, so a new secret
  // compared with !== is caught.
  const offenders = sourceFiles().flatMap((f) =>
    f.text
      .split("\n")
      .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
      .filter((l) => /(!==|===)\s*(await\s+)?(hmacHex|sha256Hex)\(/.test(l.text) || /(csrfCookie|stateCookie|clientSecret)\s*(!==|===)/.test(l.text))
  );
  assert.deepEqual(
    offenders.map((o) => `src/${o.file}:${o.line} ${o.text}`),
    [],
    "a secret is compared with === or !== instead of timingSafeEqual"
  );
});

test("move and lint finalize still accept an optional boolean confirm", async () => {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgent("DrDustinEdwards"));
  const client = new Client({ name: "confirm-schema", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  for (const name of ["move", "lint"]) {
    const schema = tools.find((t) => t.name === name)?.inputSchema;
    assert.ok(schema, `${name} is not served`);
    assert.equal((schema.properties?.confirm as { type?: string } | undefined)?.type, "boolean", `${name} does not accept confirm`);
    assert.equal((schema.required ?? []).includes("confirm"), false, `${name} requires confirm`);
  }
});
