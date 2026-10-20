import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.ts";
import { adminAgentForEmail } from "../src/agents.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// One definition, imported. Conventions about the shape of src/ rather than the
// behaviour of any one module: each guard asks whether a fact is still stated once,
// and scans all of src/ rather than a list of files where a copy might appear.
//
// That the backup prune still reaps the report prefix the CSP sink stored under until
// 2026-10-20 is driven in test-integration/csp-report.test.ts: an aged report is reaped.

// scanner-rule: quality audit 6.6 and 1.1, one definition imported everywhere
test("every secret compare goes through safeEqual, in every file", () => {
  // The specific compares, still where they belong.
  const auth = sourceFiles().find((f) => f.name === "auth.ts")!.text;
  const handler = sourceFiles().find((f) => f.name === "routes.ts")!.text;
  assert.ok(auth.includes("await safeEqual(readonly ? entry.slice(3) : entry, hash)"));
  assert.match(handler, /await safeEqual\(sig, await hmacHex/);
  assert.match(handler, /await safeEqual\(csrfCookie, csrf\)/);
  const accessLogin = sourceFiles().find((f) => f.name === "access-login.ts")!.text;
  assert.match(accessLogin, /await safeEqual\(await sha256Hex\(stateCookie\), signIn\.binding\)/);

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
    "a secret is compared with === or !== instead of safeEqual"
  );
});

// safeEqual and the admin check built on it return promises, and a promise is truthy: a
// call that loses its await admits every caller, and neither tsc nor the tests see it.
test("every safeEqual, isAdminEmail and adminGrantEmail call is awaited, in every file", () => {
  const calls = sourceFiles().flatMap((f) =>
    f.text
      .split("\n")
      .map((line, i) => ({ file: f.name, line: i + 1, text: line.trim() }))
      .flatMap((l) => [...l.text.matchAll(/(\bawait\s+\(?)?\b(safeEqual|isAdminEmail|adminGrantEmail)\(/g)].map((m) => ({ ...l, awaited: Boolean(m[1]) })))
      .filter((c) => !/^export async function /.test(c.text))
  );
  assert.ok(calls.length >= 17, `found only ${calls.length} calls`);
  assert.deepEqual(calls.filter((c) => !c.awaited).map((c) => `src/${c.file}:${c.line} ${c.text}`), []);
});

test("move and lint finalize still accept an optional boolean confirm", async () => {
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "confirm-schema", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  // move is an action of capsid_write_doc; lint finalize a mode of capsid_lint_namespace.
  for (const name of ["capsid_write_doc", "capsid_lint_namespace"]) {
    const schema = tools.find((t) => t.name === name)?.inputSchema;
    assert.ok(schema, `${name} is not served`);
    assert.equal((schema.properties?.confirm as { type?: string } | undefined)?.type, "boolean", `${name} does not accept confirm`);
    assert.equal((schema.required ?? []).includes("confirm"), false, `${name} requires confirm`);
  }
});
