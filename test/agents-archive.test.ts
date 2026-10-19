import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mintAgent, listAgents } from "../src/agents-admin.ts";
import { ARCHIVE_AFTER_DAYS, archiveRevokedAgents, listArchivedAgents } from "../src/agents-archive.ts";
import { resolveAgent } from "../src/agents.ts";
import { sha256Hex } from "../src/auth.ts";
import { agentSummaries } from "../src/status.ts";

// Revoked agents move to agents_archive and keep their history (job_24e460427d6c). The
// move is SQL across five tables, so these run every migration with Node's SQLite and
// drive the real statements through a small D1 shape, rather than the D1 fake, which
// models no subquery or UNION.

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const NOW = new Date("2026-10-10T12:00:00Z");
const ACTOR = "agent:watcher";

// prepare, bind, first, all, run and batch, which is all these readers call.
function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const s = db.prepare(sql);
    const args = params as Array<string | number | null>;
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (s.get(...args) as Record<string, unknown> | undefined) ?? null,
      all: async () => ({ results: s.all(...args).map((r) => ({ ...r })) }),
      run: async () => {
        const r = s.run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: Array<ReturnType<typeof statement>>) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

function fresh(): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return { raw, db: d1(raw) };
}

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const daysAgo = (n: number) => sqlTime(new Date(NOW.getTime() - n * 86_400_000));

async function plantAgent(raw: DatabaseSync, name: string, revoked: string | null, jobId: string | null = null): Promise<string> {
  const key = `key-${name}`;
  raw
    .prepare("INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at, revoked_at, job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(`agent_${name}`, name, jobId ? "session" : "driver", await sha256Hex(key), JSON.stringify({ namespaces: ["sample"], repos: [], tools: "*", grants: ["read"], flags: {} }), "access:dustin@example.com", daysAgo(30), revoked, jobId);
  return key;
}

function plantJob(raw: DatabaseSync, id: string, status: string, by: string): void {
  raw.prepare("INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by) VALUES (?, 'sample', ?, 'b', ?, 'access:dustin@example.com', ?)").run(id, `t ${id}`, status, by);
}

const names = (raw: DatabaseSync, table: string) => raw.prepare(`SELECT name FROM ${table} ORDER BY name`).all().map((r) => r.name);

test("a revoked agent moves 7 days after revocation with its counts and an audit row; a live one and a recent one stay", async () => {
  const { raw, db } = fresh();
  await plantAgent(raw, "live", null);
  await plantAgent(raw, "recent", daysAgo(ARCHIVE_AFTER_DAYS - 1));
  await plantAgent(raw, "old", daysAgo(ARCHIVE_AFTER_DAYS + 1));
  for (let i = 0; i < 3; i++) raw.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:old', 'write', 'sample', 'p', '{}')").run();
  plantJob(raw, "job_aaaaaaaaaaaa", "done", "agent:old");
  plantJob(raw, "job_bbbbbbbbbbbb", "queued", "agent:live");
  assert.equal(names(raw, "agents").length, 3, "the plant did not land");

  const pass = await archiveRevokedAgents(db, ACTOR, NOW);
  assert.deepEqual(pass, { archived: [{ name: "old", reason: "revoked-7-days" }], skipped: [] });
  assert.deepEqual(names(raw, "agents"), ["live", "recent"]);
  const row = raw.prepare("SELECT * FROM agents_archive WHERE name = 'old'").get()!;
  assert.equal(row.audit_rows, 3);
  assert.equal(row.jobs, 1);
  assert.equal(row.reason, "revoked-7-days");
  assert.equal(row.revoked_at, daysAgo(ARCHIVE_AFTER_DAYS + 1), "the row is copied, not re-stamped");
  const audit = raw.prepare("SELECT actor, path, params FROM audit_log WHERE action = 'agents.archive'").all();
  assert.deepEqual(audit.map((a) => [a.actor, a.path]), [[ACTOR, "old"]]);
  // A second pass has nothing left to move.
  assert.deepEqual(await archiveRevokedAgents(db, ACTOR, NOW), { archived: [], skipped: [] });
});

test("a runner key moves once its job has ended, and waits its 7 days while the job is only blocked", async () => {
  const { raw, db } = fresh();
  plantJob(raw, "job_cccccccccccc", "done", "agent:runner-done");
  plantJob(raw, "job_dddddddddddd", "blocked", "agent:runner-blocked");
  await plantAgent(raw, "runner-done", daysAgo(0.1), "job_cccccccccccc");
  await plantAgent(raw, "runner-blocked", daysAgo(0.1), "job_dddddddddddd");
  const pass = await archiveRevokedAgents(db, ACTOR, NOW);
  assert.deepEqual(pass.archived, [{ name: "runner-done", reason: "runner-job-ended" }]);
  assert.deepEqual(names(raw, "agents"), ["runner-blocked"]);
});

test("PLANT: an archived key is refused, and not tried as an operator key even when it is one", async () => {
  const { raw, db } = fresh();
  const key = await plantAgent(raw, "gone", daysAgo(ARCHIVE_AFTER_DAYS + 1));
  await archiveRevokedAgents(db, ACTOR, NOW);
  assert.deepEqual(names(raw, "agents_archive"), ["gone"], "the plant did not land in the archive");
  const request = new Request("https://capsid.example.com/ops/mcp", { headers: { Authorization: `Bearer ${key}` } });
  // The same digest as a write operator key: a refusal that only looked in agents would
  // fall through and resolve it as the operator.
  const env = { DB: db, OPERATOR_KEY_HASH: await sha256Hex(key) };
  assert.equal(await resolveAgent(request, env, NOW), null);
});

test("PLANT: an archived name is never minted again", async () => {
  const { raw, db } = fresh();
  await plantAgent(raw, "gone", daysAgo(ARCHIVE_AFTER_DAYS + 1));
  await archiveRevokedAgents(db, ACTOR, NOW);
  assert.deepEqual(names(raw, "agents"), [], "the plant is still in the live table");
  const minted = await mintAgent(db, "access:dustin@example.com", { name: "gone", kind: "driver", namespaces: ["sample"], repos: ["*"] });
  assert.equal(minted.ok, false);
  assert.match(minted.refusal ?? "", /already exists/);
  assert.deepEqual(names(raw, "agents"), []);
});

test("the inventory lists live, then revoked, then archived with archived_at; the archive read never returns the verifier", async () => {
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
    ]
  );
  assert.deepEqual((await listAgents(db)).agents?.map((a) => a.name), ["revoked", "zz-live"], "list is the live table");
  const archived = await listArchivedAgents(db);
  assert.deepEqual(archived.map((a) => a.name), ["aa-gone"]);
  assert.equal("key_hash" in archived[0], false);
  assert.match(archived[0].fingerprint, /^[0-9a-f]{12}$/);
});
