import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { adminAgentForEmail, legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import type { Env } from "../src/env";
import { NAMESPACE_DELETE_MAX_DOCUMENTS, planFingerprint, readDeletePlan, signDeleteToken } from "../src/namespace-delete";
import { buildAdminServer, buildServer } from "../src/server";

// capsid_admin_manage_namespaces delete_preview and delete_perform (Capsid Admin)
// against a real D1 and KV: every refusal the preview gives, every way
// a token is refused at perform, the one batch deleting exactly what the preview
// listed with a snapshot per document, and the in-batch guard aborting on a change
// that lands after the perform re-read its plan. The file shares one store, so every
// test works in its own fresh namespace.

const SECRET = "integration-namespace-delete-key";
const ADMIN = adminAgentForEmail("admin@example.com");
const ACTOR = ADMIN.actor;

function workerEnv(db: D1Database = env.DB): Env {
  return { ...(env as unknown as Env), DB: db, COOKIE_ENCRYPTION_KEY: SECRET };
}

let seq = 0;
function fresh(): string {
  seq += 1;
  return `sample-${`${Date.now().toString(16)}${seq.toString(16)}`.slice(-10)}`;
}

function driver(ns: string): Agent {
  const scopes = defaultScopes([ns]);
  scopes.grants = ["read", "write"];
  return { id: "agent_driver00002", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

interface Result {
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function callAs(caller: Agent, args: Record<string, unknown>, db?: D1Database): Promise<Result> {
  const server = buildAdminServer(workerEnv(db) as never, caller);
  const client = new Client({ name: "delete-namespace", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: "capsid_admin_manage_namespaces", arguments: args })) as Result;
  } finally {
    await client.close();
  }
}

interface Preview {
  verdict: "allowed" | "refused";
  refusals: string[];
  counts: Record<string, number>;
  token?: string;
  open_jobs: Array<{ id: string }>;
  live_agents: string[];
  policy_paths: string[];
}

async function preview(ns: string, extra: Record<string, unknown> = {}): Promise<Preview> {
  const result = await callAs(ADMIN, { namespace: ns, action: "delete_preview", ...extra });
  expect(result.isError, result.content[0].text).not.toBe(true);
  return JSON.parse(result.content[0].text) as Preview;
}

async function register(ns: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(ns).run();
}

async function doc(ns: string, path: string, body = "lorem ipsum"): Promise<void> {
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, ?3, ?4)").bind(ns, path, path, body).run();
}

async function edge(fromNs: string, fromPath: string, toNs: string, toPath: string): Promise<void> {
  await env.DB.prepare("INSERT INTO document_links (from_ns, from_path, type, to_ns, to_path) VALUES (?1, ?2, 'references', ?3, ?4)")
    .bind(fromNs, fromPath, toNs, toPath)
    .run();
}

async function job(ns: string, id: string, status: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO jobs (id, namespace, title, body, status, posted_by) VALUES (?1, ?2, ?3, 'body', ?4, 'github:sample')"
  )
    .bind(id, ns, `a ${status} job ${id}`, status)
    .run();
}

async function agent(name: string, namespaces: string[], revoked: boolean): Promise<void> {
  const scopes = defaultScopes(namespaces);
  await env.DB.prepare(
    "INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, revoked_at) VALUES (?1, ?2, 'driver', ?3, ?4, 'github:sample', ?5)"
  )
    .bind(`agent_${name.slice(-12)}`, name, `hash-${name}`, JSON.stringify(scopes), revoked ? "2026-09-01 00:00:00" : null)
    .run();
}

async function n(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function auditRows(ns: string): Promise<number> {
  return n("SELECT COUNT(*) AS n FROM audit_log WHERE namespace = ?1", ns);
}

describe("capsid_admin_manage_namespaces delete_preview refusals", () => {
  it("an unregistered namespace is refused as not found", async () => {
    const result = await callAs(ADMIN, { namespace: fresh(), action: "delete_preview" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/namespace not found/);
  });

  for (const status of ["queued", "claimed", "blocked"]) {
    it(`PLANT: a ${status} job refuses it, even with cascade, and names the job and the jobs tool`, async () => {
      const ns = fresh();
      await register(ns);
      const id = `job_${ns.slice(-12)}`;
      await job(ns, id, status);
      const before = await auditRows(ns);
      const p = await preview(ns, { cascade: true });
      expect(p.verdict).toBe("refused");
      expect(p.token).toBeUndefined();
      expect(p.refusals.join(" ")).toContain(id);
      expect(p.refusals.join(" ")).toMatch(/cascade never reaches jobs/);
      expect(p.refusals.join(" ")).toMatch(/jobs tool/);
      expect(await auditRows(ns), "a preview wrote an audit row").toBe(before);
    });
  }

  it("a finished job does not refuse it, and is counted as kept", async () => {
    const ns = fresh();
    await register(ns);
    await job(ns, `job_${ns.slice(-12)}`, "done");
    const p = await preview(ns);
    expect(p.verdict, p.refusals.join(" ")).toBe("allowed");
    expect(p.counts.jobs_finished).toBe(1);
  });

  it("PLANT: a live agent naming it refuses it, even with cascade, and names the agents tool", async () => {
    const ns = fresh();
    await register(ns);
    await agent(`${ns}-live`, [ns], false);
    const p = await preview(ns, { cascade: true });
    expect(p.verdict).toBe("refused");
    expect(p.live_agents).toEqual([`${ns}-live`]);
    expect(p.refusals.join(" ")).toMatch(/cascade never reaches agents/);
    expect(p.refusals.join(" ")).toMatch(/'revoke'|update_scopes/);
  });

  it("a revoked agent naming it does not refuse it, and is counted", async () => {
    const ns = fresh();
    await register(ns);
    await agent(`${ns}-gone`, [ns], true);
    const p = await preview(ns);
    expect(p.verdict, p.refusals.join(" ")).toBe("allowed");
    expect(p.counts.agents_revoked).toBe(1);
    expect(p.counts.agents_live).toBe(0);
  });

  it("PLANT: live documents refuse it without cascade, and cascade allows it", async () => {
    const ns = fresh();
    await register(ns);
    await doc(ns, "notes/a.md");
    const without = await preview(ns);
    expect(without.verdict).toBe("refused");
    expect(without.refusals.join(" ")).toMatch(/cascade: true/);
    const withCascade = await preview(ns, { cascade: true });
    expect(withCascade.verdict, withCascade.refusals.join(" ")).toBe("allowed");
    expect(withCascade.token).toBeTruthy();
  });

  it("archived documents alone need no cascade: they are kept", async () => {
    const ns = fresh();
    await register(ns);
    await doc(ns, "archive/old.md");
    const p = await preview(ns);
    expect(p.verdict, p.refusals.join(" ")).toBe("allowed");
    expect(p.counts.documents_archived).toBe(1);
    expect(p.counts.documents_live).toBe(0);
  });

  it("PLANT: a policy document refuses it without allow_improve_paths", async () => {
    const ns = fresh();
    await register(ns);
    await doc(ns, "policy/auto-merge.md", "lorem ipsum");
    const p = await preview(ns, { cascade: true });
    expect(p.verdict).toBe("refused");
    expect(p.refusals.join(" ")).toMatch(/allow_improve_paths/);
    expect(p.policy_paths).toEqual(["policy/auto-merge.md"]);
    const allowed = await preview(ns, { cascade: true, allow_improve_paths: true });
    expect(allowed.verdict, allowed.refusals.join(" ")).toBe("allowed");
  });

  it("PLANT: a namespace on the roster is refused", async () => {
    await register("germomics");
    const p = await preview("germomics", { cascade: true, allow_improve_paths: true });
    expect(p.verdict).toBe("refused");
    expect(p.refusals.join(" ")).toMatch(/roster/);
  });
});

describe("capsid_admin_manage_namespaces is admin only", () => {
  it("PLANT: a driver scoped to the namespace with the write grant is refused by checkScope, and nothing changes", async () => {
    const ns = fresh();
    await register(ns);
    for (const action of ["delete_preview", "delete_perform"]) {
      const result = await callAs(driver(ns), { namespace: ns, action, cascade: true, token: "x.0" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/'capsid_admin_manage_namespaces\.(delete_preview|delete_perform)' is admin only/);
    }
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });

  it("a read-only caller is refused the write grant", async () => {
    const ns = fresh();
    await register(ns);
    const result = await callAs(legacyAgent("read", "opkey:readonly0000"), { namespace: ns, action: "delete_preview" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires the write grant/);
  });
});

describe("capsid_admin_manage_namespaces delete_perform refuses a token that does not match", () => {
  it("a perform with no token is refused", async () => {
    const ns = fresh();
    await register(ns);
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/needs the token/);
  });

  it("PLANT: a document written after the preview refuses the token, and nothing is deleted", async () => {
    const ns = fresh();
    await register(ns);
    await doc(ns, "a.md");
    const p = await preview(ns, { cascade: true });
    await doc(ns, "b.md");
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", cascade: true, token: p.token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/changed since the preview/);
    expect(result.content[0].text).toMatch(/documents_live 1 -> 2/);
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1", ns)).toBe(2);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });

  it("PLANT: a document swapped for another after the preview refuses the token, though the count is the same", async () => {
    const ns = fresh();
    await register(ns);
    await doc(ns, "a.md");
    const p = await preview(ns, { cascade: true });
    await env.DB.prepare("DELETE FROM documents WHERE namespace = ?1 AND path = 'a.md'").bind(ns).run();
    await doc(ns, "c.md");
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", cascade: true, token: p.token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/live_paths_sha256/);
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path = 'c.md'", ns)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });

  it("PLANT: a token for another namespace is refused", async () => {
    const a = fresh();
    const b = fresh();
    await register(a);
    await register(b);
    const p = await preview(a);
    const result = await callAs(ADMIN, { namespace: b, action: "delete_perform", token: p.token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(new RegExp(`issued for namespace ${a}`));
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace IN (?1, ?2)", a, b)).toBe(2);
  });

  it("PLANT: a token issued with another cascade value is refused", async () => {
    const ns = fresh();
    await register(ns);
    const p = await preview(ns, { cascade: true });
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token: p.token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/issued with cascade true/);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });

  it("PLANT: an expired token is refused", async () => {
    const ns = fresh();
    await register(ns);
    const plan = await readDeletePlan(env.DB, ns);
    const token = await signDeleteToken(workerEnv(), {
      v: 1,
      namespace: ns,
      cascade: false,
      allow_improve_paths: false,
      actor: ACTOR,
      plan: planFingerprint(plan),
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/expired/);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });

  it("PLANT: a token issued to another caller is refused", async () => {
    const ns = fresh();
    await register(ns);
    const plan = await readDeletePlan(env.DB, ns);
    const token = await signDeleteToken(workerEnv(), {
      v: 1,
      namespace: ns,
      cascade: false,
      allow_improve_paths: false,
      actor: "access:someone-else@example.com",
      plan: planFingerprint(plan),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/another caller/);
  });

  it("PLANT: a token signed under another key does not verify", async () => {
    const ns = fresh();
    await register(ns);
    const plan = await readDeletePlan(env.DB, ns);
    const token = await signDeleteToken(
      { COOKIE_ENCRYPTION_KEY: "not-the-worker-key" },
      { v: 1, namespace: ns, cascade: false, allow_improve_paths: false, actor: ACTOR, plan: planFingerprint(plan), exp: Math.floor(Date.now() / 1000) + 60 }
    );
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not verify/);
  });

  it("PLANT: a job opened after the preview refuses the perform", async () => {
    const ns = fresh();
    await register(ns);
    const p = await preview(ns);
    await job(ns, `job_${ns.slice(-12)}`, "queued");
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token: p.token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/open job/);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });
});

describe("capsid_admin_manage_namespaces delete_perform", () => {
  it("deletes exactly what the preview listed, snapshots each document and keeps the history", async () => {
    const ns = fresh();
    const other = fresh();
    await register(ns);
    await register(other);
    await doc(ns, "core.md", "core body");
    await doc(ns, "notes/a.md", "a body");
    await doc(ns, `jobs/job_${ns.slice(-12)}.md`, "mirror body");
    await doc(ns, "archive/old.md", "old body");
    await doc(ns, "archive/older.md", "older body");
    await doc(other, "x.md", "other body");
    await edge(ns, "notes/a.md", ns, "core.md");
    await edge(other, "x.md", ns, "core.md");
    await edge(ns, "notes/a.md", other, "x.md");
    await edge(ns, "archive/old.md", ns, "archive/older.md");
    // Already dangling: its end in ns names no document, so no pathMutation touches it.
    await edge(other, "x.md", ns, "never-existed.md");
    await job(ns, `job_${ns.slice(-12)}`, "done");
    await agent(`${ns}-gone`, [ns], true);
    await env.DB.prepare("INSERT INTO ops_sites (namespace, name, origin, platform) VALUES (?1, 'Sample', 'https://sample.example.com', 'cloudflare')")
      .bind(ns)
      .run();
    await env.DB.prepare("INSERT INTO access_sync_groups (namespace, group_id, group_name, pinned_by) VALUES (?1, ?2, 'sample-people', 'access:admin@example.com')")
      .bind(ns, `group-${ns}`)
      .run();

    const p = await preview(ns, { cascade: true });
    expect(p.verdict, p.refusals.join(" ")).toBe("allowed");
    expect(p.counts.documents_live).toBe(3);
    expect(p.counts.documents_archived).toBe(2);
    expect(p.counts.document_links_removed).toBe(3);

    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", cascade: true, token: p.token });
    expect(result.isError, result.content[0].text).not.toBe(true);
    const done = JSON.parse(result.content[0].text) as {
      documents_deleted: number;
      snapshots: number;
      edges_removed: number;
      ops_site_removed: boolean;
    };
    expect(done.documents_deleted).toBe(3);
    expect(done.snapshots).toBe(3);
    expect(done.edges_removed).toBe(3);
    expect(done.ops_site_removed).toBe(true);

    // Deleted: the live documents, their edges, the site row, the mapping.
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path NOT LIKE 'archive/%'", ns)).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM ops_sites WHERE namespace = ?1", ns)).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM access_sync_groups WHERE namespace = ?1", ns)).toBe(0);
    expect(
      await n(
        "SELECT COUNT(*) AS n FROM document_links WHERE (from_ns = ?1 AND from_path IN ('core.md', 'notes/a.md')) OR (to_ns = ?1 AND to_path IN ('core.md', 'notes/a.md'))",
        ns
      )
    ).toBe(0);

    // Snapshotted: each live document's body, by path.
    const { results: versions } = await env.DB.prepare("SELECT path, body FROM document_versions WHERE namespace = ?1 AND document_id IS NOT NULL ORDER BY path")
      .bind(ns)
      .all<{ path: string; body: string }>();
    expect(versions.map((v) => [v.path, v.body])).toEqual([
      ["core.md", "core body"],
      [`jobs/job_${ns.slice(-12)}.md`, "mirror body"],
      ["notes/a.md", "a body"],
    ]);

    // Kept: the archive and its own edge, the other namespace, the finished job, the
    // revoked agent.
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1 AND path LIKE 'archive/%'", ns)).toBe(2);
    expect(await n("SELECT COUNT(*) AS n FROM document_links WHERE from_ns = ?1 AND from_path = 'archive/old.md'", ns)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1", other)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM document_links WHERE to_ns = ?1 AND to_path = 'never-existed.md'", ns)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM jobs WHERE namespace = ?1", ns)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM agents WHERE name = ?1", `${ns}-gone`)).toBe(1);

    // Recorded: one audit row holding the edges, the paths and both rows whole.
    const audit = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'namespace-delete' AND namespace = ?1")
      .bind(ns)
      .all<{ actor: string; params: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0].actor).toBe(ACTOR);
    const params = JSON.parse(audit.results[0].params) as {
      plan: { counts: Record<string, number>; cascade: boolean; documents_deleted: string[] };
      edges_removed: Array<Record<string, string>>;
      ops_site: Record<string, unknown> | null;
      access_sync_group: Record<string, unknown> | null;
      namespace_row: Record<string, unknown> | null;
    };
    expect(params.plan.cascade).toBe(true);
    expect(params.plan.counts.documents_live).toBe(3);
    expect(params.plan.documents_deleted.sort()).toEqual(["core.md", `jobs/job_${ns.slice(-12)}.md`, "notes/a.md"].sort());
    expect(params.edges_removed).toHaveLength(3);
    expect(params.edges_removed).toContainEqual({ from_ns: other, from_path: "x.md", type: "references", to_ns: ns, to_path: "core.md" });
    expect(params.ops_site?.origin).toBe("https://sample.example.com");
    expect(params.ops_site?.revision).toBe(1);
    expect(params.access_sync_group?.group_name).toBe("sample-people");
    expect(params.namespace_row?.namespace).toBe(ns);

    // The archive stays readable under the deleted name.
    const server = buildServer(workerEnv() as never, ADMIN);
    const client = new Client({ name: "delete-namespace-read", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const read = (await client.callTool({ name: "capsid_read_doc", arguments: { action: "read", namespace: ns, path: "archive/old.md" } })) as Result;
    await client.close();
    expect(read.isError, read.content[0].text).not.toBe(true);
    expect(read.content[0].text).toContain("old body");
  });

  it("a second perform with the same token is refused: the namespace is gone", async () => {
    const ns = fresh();
    await register(ns);
    const p = await preview(ns);
    const first = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token: p.token });
    expect(first.isError, first.content[0].text).not.toBe(true);
    const second = await callAs(ADMIN, { namespace: ns, action: "delete_perform", token: p.token });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/namespace not found/);
  });

  it("PLANT: a document landing between the perform's re-read and its batch aborts the batch, and nothing changes", async () => {
    // The re-read is itself a batch (readDeletePlan), so the race is staged on the
    // second batch call: the delete's own. The guard, not the fingerprint, must catch it.
    const ns = fresh();
    await register(ns);
    await doc(ns, "a.md");
    const p = await preview(ns, { cascade: true });
    let batches = 0;
    const racing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      exec: (sql: string) => env.DB.exec(sql),
      dump: () => env.DB.dump(),
      withSession: (c?: string) => env.DB.withSession(c),
      batch: async (statements: D1PreparedStatement[]) => {
        batches += 1;
        if (batches === 2) await doc(ns, "late.md");
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", cascade: true, token: p.token }, racing);
    expect(batches).toBe(2);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/aborted, nothing changed/);
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1", ns)).toBe(2);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
    expect(await n("SELECT COUNT(*) AS n FROM document_versions WHERE namespace = ?1", ns)).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'namespace-delete' AND namespace = ?1", ns)).toBe(0);
  });
});

async function docs(ns: string, count: number): Promise<void> {
  await env.DB.batch(
    Array.from({ length: count }, (_, i) =>
      env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, ?2, ?3)").bind(ns, `notes/${String(i).padStart(3, "0")}.md`, `body ${i}`)
    )
  );
}

describe("capsid_admin_manage_namespaces delete batch cap", () => {
  it("PLANT: a namespace over the batch cap is refused at preview, not half deleted", async () => {
    const ns = fresh();
    await register(ns);
    await docs(ns, NAMESPACE_DELETE_MAX_DOCUMENTS + 1);
    const p = await preview(ns, { cascade: true });
    expect(p.verdict).toBe("refused");
    expect(p.token).toBeUndefined();
    const refusal = p.refusals.join(" ");
    expect(refusal).toContain(`holds ${NAMESPACE_DELETE_MAX_DOCUMENTS + 1} live documents`);
    expect(refusal).toContain(`at most ${NAMESPACE_DELETE_MAX_DOCUMENTS}`);
    expect(refusal).toMatch(/Delete documents with capsid_delete_doc, or move them with capsid_write_doc action move, first, or ask the seat to rule a set-based helper/);

    // A token signed over this very plan is refused at perform too, by the same rule.
    const plan = await readDeletePlan(env.DB, ns);
    const token = await signDeleteToken(workerEnv(), {
      v: 1,
      namespace: ns,
      cascade: true,
      allow_improve_paths: false,
      actor: ACTOR,
      plan: planFingerprint(plan),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", cascade: true, token });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`at most ${NAMESPACE_DELETE_MAX_DOCUMENTS}`);
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1", ns)).toBe(NAMESPACE_DELETE_MAX_DOCUMENTS + 1);
    expect(await n("SELECT COUNT(*) AS n FROM document_versions WHERE namespace = ?1", ns)).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(1);
  });

  it("a namespace at exactly the cap is deleted in one batch, each document snapshotted", async () => {
    const ns = fresh();
    await register(ns);
    await docs(ns, NAMESPACE_DELETE_MAX_DOCUMENTS);
    const p = await preview(ns, { cascade: true });
    expect(p.verdict, p.refusals.join(" ")).toBe("allowed");
    const result = await callAs(ADMIN, { namespace: ns, action: "delete_perform", cascade: true, token: p.token });
    expect(result.isError, result.content[0].text).not.toBe(true);
    const done = JSON.parse(result.content[0].text) as { documents_deleted: number; snapshots: number };
    expect(done.documents_deleted).toBe(NAMESPACE_DELETE_MAX_DOCUMENTS);
    expect(done.snapshots).toBe(NAMESPACE_DELETE_MAX_DOCUMENTS);
    expect(await n("SELECT COUNT(*) AS n FROM documents WHERE namespace = ?1", ns)).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM document_versions WHERE namespace = ?1 AND document_id IS NOT NULL", ns)).toBe(NAMESPACE_DELETE_MAX_DOCUMENTS);
    expect(await n("SELECT COUNT(*) AS n FROM namespaces WHERE namespace = ?1", ns)).toBe(0);
  });
});
