import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mintAgent } from "../src/agents-admin.ts";
import {
  ARCHIVE_AFTER_DAYS,
  archiveRevokedAgents,
  listArchivedAgents,
} from "../src/agents-archive.ts";
import { resolveAgent } from "../src/agents.ts";

import { agentSummaries } from "../src/status.ts";
import { d1, migratedDb } from "./sqlite-d1.ts";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// Revoked agents are archived in place and keep their history (job_24e460427d6c). The
// move is SQL across five tables, so these run every migration with Node's SQLite and
// drive the real statements through a small D1 shape, rather than the D1 fake, which
// models no subquery or UNION.

const NOW = new Date("2026-10-10T12:00:00Z");
const ACTOR = "agent:watcher";

function fresh(): { raw: DatabaseSync; db: D1Database } {
  const raw = migratedDb();
  return { raw, db: d1(raw) };
}

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const daysAgo = (n: number) => sqlTime(new Date(NOW.getTime() - n * 86_400_000));

async function plantAgent(
  raw: DatabaseSync,
  name: string,
  revoked: string | null,
): Promise<string> {
  const key = `key-${name}`;
  raw
    .prepare(
      "INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `agent_${name}`,
      name,
      "driver",
      await sha256Hex(key),
      JSON.stringify({
        namespaces: ["sample"],
        repos: [],
        tools: "*",
        grants: ["read"],
        flags: {},
      }),
      "access:dustin@example.com",
      daysAgo(30),
      revoked,
    );
  return key;
}

function plantJob(raw: DatabaseSync, id: string, status: string, by: string): void {
  raw
    .prepare(
      "INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by) VALUES (?, 'sample', ?, 'b', ?, 'access:dustin@example.com', ?)",
    )
    .run(id, `t ${id}`, status, by);
}

const names = (raw: DatabaseSync, where = "archived_at IS NULL") =>
  raw
    .prepare(`SELECT name FROM agents WHERE ${where} ORDER BY name`)
    .all()
    .map((r) => r.name);
const archivedNames = (raw: DatabaseSync) => names(raw, "archived_at IS NOT NULL");

test("a revoked agent moves 7 days after revocation with its counts and an audit row; a live one and a recent one stay", async () => {
  const { raw, db } = fresh();
  await plantAgent(raw, "live", null);
  await plantAgent(raw, "recent", daysAgo(ARCHIVE_AFTER_DAYS - 1));
  await plantAgent(raw, "old", daysAgo(ARCHIVE_AFTER_DAYS + 1));
  for (let i = 0; i < 3; i++)
    raw
      .prepare(
        "INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:old', 'write', 'sample', 'p', '{}')",
      )
      .run();
  plantJob(raw, "job_aaaaaaaaaaaa", "done", "agent:old");
  plantJob(raw, "job_bbbbbbbbbbbb", "queued", "agent:live");
  assert.equal(names(raw).length, 3, "the plant did not land");

  const pass = await archiveRevokedAgents(db, ACTOR, NOW);
  assert.deepEqual(pass, { archived: [{ name: "old", reason: "revoked-7-days" }], skipped: [] });
  assert.deepEqual(names(raw), ["live", "recent"]);
  const row = raw.prepare("SELECT * FROM agents WHERE name = 'old'").get()!;
  assert.equal(row.audit_rows, 3);
  assert.equal(row.jobs, 1);
  assert.equal(row.archive_reason, "revoked-7-days");
  assert.equal(row.revoked_at, daysAgo(ARCHIVE_AFTER_DAYS + 1), "revoked_at is not re-stamped");
  const audit = raw
    .prepare("SELECT actor, path, params FROM audit_log WHERE action = 'agents.archive'")
    .all();
  assert.deepEqual(
    audit.map((a) => [a.actor, a.path]),
    [[ACTOR, "old"]],
  );
  // A second pass has nothing left to move.
  assert.deepEqual(await archiveRevokedAgents(db, ACTOR, NOW), { archived: [], skipped: [] });
});

test("PLANT: an archived key is refused and its name is never minted again", async () => {
  const { raw, db } = fresh();
  const key = await plantAgent(raw, "gone", daysAgo(ARCHIVE_AFTER_DAYS + 1));
  await archiveRevokedAgents(db, ACTOR, NOW);
  assert.deepEqual(archivedNames(raw), ["gone"], "the plant was not archived");
  const request = new Request("https://capsid.example.com/ops/mcp", {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(await resolveAgent(request, { DB: db }, NOW), null);
  const minted = await mintAgent(db, "access:dustin@example.com", {
    name: "gone",
    kind: "driver",
    namespaces: ["sample"],
    repos: ["*"],
  });
  assert.equal(minted.ok, false);
  assert.match(minted.refusal ?? "", /already exists/);
});

test("the inventory marks archived agents; the archive read never returns the verifier", async () => {
  const { raw, db } = fresh();
  await plantAgent(raw, "zz-live", null);
  await plantAgent(raw, "revoked", daysAgo(1));
  await plantAgent(raw, "aa-gone", daysAgo(ARCHIVE_AFTER_DAYS + 1));
  await archiveRevokedAgents(db, ACTOR, NOW);
  const inventory = await agentSummaries(db);
  assert.deepEqual(
    inventory.map((a) => [a.name, a.revoked_at !== null, a.archived_at !== null]),
    [
      ["zz-live", false, false],
      ["revoked", true, false],
      ["aa-gone", true, true],
    ],
  );
  const archived = await listArchivedAgents(db);
  assert.deepEqual(
    archived.map((a) => a.name),
    ["aa-gone"],
  );
  assert.equal("key_hash" in archived[0], false);
});
