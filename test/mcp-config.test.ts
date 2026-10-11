import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// CLAUDE.md, public repo rule. The committed .mcp.json names Capsid's /ops/mcp for a
// cloud session, where the Claude Code network secret adds the driver key on the way
// out (job_a7d6f6009242). The key is never inside the session and never in this file.

const FILE = join(import.meta.dirname, "..", ".mcp.json");

/** Why a committed .mcp.json text is refused, or [] when it carries no credential. */
function credentialViolations(text: string): string[] {
  const out: string[] = [];
  const config = JSON.parse(text) as { mcpServers?: Record<string, Record<string, unknown>> };
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (server.headers !== undefined) out.push(`${name}: carries headers`);
    if (server.env !== undefined) out.push(`${name}: carries env`);
  }
  if (/authorization/i.test(text)) out.push("names an Authorization value");
  if (/bearer\s/i.test(text)) out.push("carries a Bearer value");
  // Key-shaped: a long unbroken run of key characters, the way a minted key or a token reads.
  if (/[A-Za-z0-9_\-+/=.]{32,}/.test(text.replace(/https:\/\/[^"\s]+/g, ""))) out.push("carries a key-shaped string");
  return out;
}

test("the committed .mcp.json carries no Authorization value and nothing key-shaped", () => {
  assert.deepEqual(credentialViolations(readFileSync(FILE, "utf8")), []);
});

test("the committed .mcp.json points the capsid server at /ops/mcp", () => {
  const config = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(config.mcpServers.capsid.url, "https://mcp.dustinedwards.info/ops/mcp");
});

test("a keyed config is refused, each way a key can arrive", () => {
  const keyed = (server: object) => JSON.stringify({ mcpServers: { capsid: { type: "http", url: "https://mcp.dustinedwards.info/ops/mcp", ...server } } });
  assert.ok(credentialViolations(keyed({ headers: { Authorization: "Bearer abc" } })).includes("names an Authorization value"));
  assert.ok(credentialViolations(keyed({ headers: { "X-Key": "x" } })).includes("capsid: carries headers"));
  assert.ok(credentialViolations(keyed({ env: { K: "v" } })).includes("capsid: carries env"));
  assert.ok(credentialViolations(keyed({ note: "bearer abc" })).includes("carries a Bearer value"));
  assert.ok(credentialViolations(keyed({ note: "cap_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6" })).includes("carries a key-shaped string"));
});
