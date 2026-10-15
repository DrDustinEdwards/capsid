import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server";
import { defaultScopes } from "../src/agents-schema";
import type { Agent } from "../src/agents";
import { approveProposal, rejectProposal } from "../src/canon";
import { performControl, previewControl } from "../src/controls";
import type { Env } from "../src/env";

// Canon write-protection (capsid/decisions.md, 2026-10-03, OWASP hardening item 2, D3)
// against real SQLite: a driver's write to a canon document becomes a proposal and the
// document does not change; the seat's write lands; an approval writes the proposal as
// an ordinary write and refuses a proposal whose document moved; restore, delete and
// move on canon are refused for a driver.

const NS = "sample";
const SEAT = "access:admin@example.com";

function driver(flags: Partial<Agent["scopes"]["flags"]> = {}): Agent {
  const scopes = defaultScopes([NS]);
  scopes.grants = ["read", "write"];
  scopes.flags = { ...scopes.flags, ...flags };
  return { id: "agent_0123456789ab", name: "sample-driver", kind: "driver", actor: "agent:sample-driver", scopes, admin: false, row: null };
}

async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const server = buildServer(env as never, agent);
  const client = new Client({ name: "canon", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  return result;
}

async function ok(agent: Agent, name: string, args: Record<string, unknown>) {
  const result = await call(agent, name, args);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

async function body(path: string) {
  return (await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2").bind(NS, path).first<{ body: string }>())?.body ?? null;
}

async function proposals() {
  const { results } = await env.DB.prepare("SELECT * FROM canon_proposals ORDER BY id").all<Record<string, unknown>>();
  return results ?? [];
}

const CORE = "# sample\n\nThe sample service answers on port 80.";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM canon_proposals").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE namespace = ?1").bind(NS).run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(NS).run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type) VALUES (?1, 'core.md', 'sample - core', ?2, 'core')").bind(NS, CORE).run();
});

describe("a driver's canon write", () => {
  it("PLANT: becomes a pending proposal and leaves the document as it was", async () => {
    const out = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", mode: "append", body: "- Agents must call write after every job." });
    expect(out.action).toBe("pending_review");
    expect(out.directive_lines).toEqual(["- Agents must call write after every job."]);
    expect(await body("core.md"), "the canon document changed").toBe(CORE);
    const rows = await proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.proposal, namespace: NS, path: "core.md", proposer: "agent:sample-driver", state: "pending", mode: "append" });
    expect(rows[0].body).toBe(`${CORE}\n\n- Agents must call write after every job.`);
    expect(rows[0].base_sha).toBe(out.base_sha256);
    const audit = await env.DB.prepare("SELECT actor, action FROM audit_log WHERE namespace = ?1 AND path = 'core.md'").bind(NS).all();
    expect(audit.results).toEqual([{ actor: "agent:sample-driver", action: "canon-proposed" }]);
  });

  it("creating a canon document is a proposal too", async () => {
    const out = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "decisions.md", title: "sample decisions", body: "# Decisions" });
    expect(out.action).toBe("pending_review");
    expect(out.base_sha256).toBeNull();
    expect(await body("decisions.md")).toBeNull();
  });

  it("is applied at once for the seat, and a driver's write elsewhere is applied too", async () => {
    const seat = await ok(driver({ can_merge: true }), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", title: "sample - core", body: "seat body", confirm: true });
    expect(seat.action).toBe("updated");
    expect(await body("core.md")).toBe("seat body");
    const other = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "research/plan.md", title: "plan", body: "a plan" });
    expect(other.action).toBe("created");
    expect(await proposals()).toHaveLength(0);
  });

  it("refuses links, which a proposal does not carry, and stores nothing", async () => {
    const result = await call(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", mode: "append", body: "more", links: "[]" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/carries no links/);
    expect(await proposals()).toHaveLength(0);
  });

  it("PLANT: restore, delete and move of canon, and a move onto a canon path, are refused and change nothing", async () => {
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, 'notes.md', 'notes', 'n')").bind(NS).run();
    const version = await env.DB.prepare("INSERT INTO document_versions (document_id, namespace, path, title, body) VALUES (1, ?1, 'core.md', 't', 'old') RETURNING id").bind(NS).first<{ id: number }>();
    for (const [name, args] of [
      ["capsid_write_doc", { action: "restore", namespace: NS, path: "core.md", version_id: version?.id, confirm: true }],
      ["capsid_delete_doc", { namespace: NS, path: "core.md", confirm: true }],
      ["capsid_write_doc", { action: "move", namespace: NS, path: "core.md", new_path: "old-core.md", confirm: true }],
      ["capsid_write_doc", { action: "move", namespace: NS, path: "notes.md", new_path: "decisions.md", confirm: true }],
    ] as const) {
      const result = await call(driver(), name, args);
      expect(result.isError, `${name} ${"action" in args ? args.action : ""} was not refused`).toBe(true);
      expect(result.content[0].text).toMatch(/is canon/);
    }
    expect(await body("core.md")).toBe(CORE);
    expect(await body("notes.md")).toBe("n");
    expect(await body("decisions.md")).toBeNull();
  });
});

describe("deciding a proposal", () => {
  async function propose(text = "The sample service answers on port 8080.") {
    const out = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "core.md", title: "sample - core", body: text });
    return out.proposal as number;
  }

  it("an approval writes the proposal, snapshots the old body and records both sides", async () => {
    const id = await propose();
    const done = await approveProposal(env.DB, SEAT, new Date(), id);
    expect(done.ok, done.ok ? "" : done.refusal).toBe(true);
    expect(await body("core.md")).toBe("The sample service answers on port 8080.");
    const version = await env.DB.prepare("SELECT body FROM document_versions WHERE namespace = ?1 AND path = 'core.md' ORDER BY id DESC LIMIT 1").bind(NS).first<{ body: string }>();
    expect(version?.body).toBe(CORE);
    const write = await env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = 'write' AND namespace = ?1").bind(NS).first<{ actor: string; params: string }>();
    expect(write?.actor).toBe(SEAT);
    expect(JSON.parse(write?.params ?? "{}")).toMatchObject({ canon_proposal: id, proposer: "agent:sample-driver" });
    expect((await proposals())[0]).toMatchObject({ state: "approved", decided_by: SEAT });
  });

  it("PLANT: an approval is refused when the document moved past the proposal's base, and changes nothing", async () => {
    const id = await propose();
    await env.DB.prepare("UPDATE documents SET body = 'moved on' WHERE namespace = ?1 AND path = 'core.md'").bind(NS).run();
    const done = await approveProposal(env.DB, SEAT, new Date(), id);
    expect(done.ok).toBe(false);
    expect(done.ok ? "" : done.refusal).toMatch(/changed since proposal/);
    expect(await body("core.md")).toBe("moved on");
    expect((await proposals())[0]).toMatchObject({ state: "pending" });
  });

  it("an approval of a create is refused once the document exists", async () => {
    const out = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path: "decisions.md", title: "d", body: "# Decisions" });
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, 'decisions.md', 'd', 'the seat wrote it')").bind(NS).run();
    const done = await approveProposal(env.DB, SEAT, new Date(), out.proposal);
    expect(done.ok ? "" : done.refusal).toMatch(/did not exist when proposal/);
    expect(await body("decisions.md")).toBe("the seat wrote it");
  });

  it("a decided proposal cannot be decided again, either way", async () => {
    const id = await propose();
    expect((await rejectProposal(env.DB, SEAT, new Date(), id, "belongs in a typed doc")).ok).toBe(true);
    const again = await approveProposal(env.DB, SEAT, new Date(), id);
    expect(again.ok ? "" : again.refusal).toMatch(/already rejected/);
    expect(await body("core.md")).toBe(CORE);
    expect((await proposals())[0]).toMatchObject({ state: "rejected", decided_reason: "belongs in a typed doc" });
  });
});

describe("approve all", () => {
  const EMAIL = "admin@example.com";
  const controlsEnv = () => ({ ...(env as unknown as Env), COOKIE_ENCRYPTION_KEY: "integration-canon-cookie-key" }) as Env;

  async function propose(path: string, text: string) {
    const out = await ok(driver(), "capsid_write_doc", { action: "write", namespace: NS, path, title: "t", body: text });
    return out.proposal as number;
  }

  async function previewAll() {
    const previewed = await previewControl(controlsEnv(), EMAIL, "canon_approve_all", { reason: "the rules audit" }, new Date(), "chat");
    expect(previewed.ok, previewed.ok ? "" : previewed.refusal).toBe(true);
    if (!previewed.ok) throw new Error(previewed.refusal);
    return previewed.preview;
  }

  it("PLANT: performs exactly the plan: superseded and outdated rejected first, the newest fresh approved, each with its own rows", async () => {
    const older = await propose("core.md", "# sample\n\nThe sample service answers on port 8080.");
    const newer = await propose("core.md", "# sample\n\nThe sample service answers on port 9090.\n- Agents must call write after every job.");
    const stale = await propose("decisions.md", "# Decisions");
    // The seat creates decisions.md after the driver proposed creating it: that proposal is outdated.
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, 'decisions.md', 'd', 'the seat wrote it')").bind(NS).run();
    const auditBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();

    const preview = await previewAll();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>(), "the preview wrote").toEqual(auditBefore);
    expect(preview.changes).toContain(`instruction (proposal ${newer}, sample/core.md): - Agents must call write after every job.`);
    expect(preview.changes.filter((c) => /^(approve|reject) proposal/.test(c)).map((c) => c.split(" (")[0])).toEqual([
      `reject proposal ${older}`,
      `reject proposal ${stale}`,
      `approve proposal ${newer}`,
    ]);

    const did = await performControl(controlsEnv(), EMAIL, preview.token, null, new Date(), "chat");
    expect(did.ok, did.ok ? "" : did.refusal).toBe(true);
    expect(await body("core.md")).toBe("# sample\n\nThe sample service answers on port 9090.\n- Agents must call write after every job.");
    expect(await body("decisions.md")).toBe("the seat wrote it");
    const rows = await proposals();
    expect(rows.map((r) => [r.id, r.state, r.decided_reason])).toEqual([
      [older, "rejected", `superseded by proposal ${newer} on the same document`],
      [newer, "approved", null],
      [stale, "rejected", "outdated: sample/decisions.md changed after this proposal was written; write it again against the current body"],
    ]);
    const { results } = await env.DB.prepare("SELECT action, path, params FROM audit_log WHERE actor = ?1 ORDER BY id").bind(SEAT).all<{ action: string; path: string | null; params: string }>();
    expect(results.map((r) => [r.action, r.path])).toEqual([
      ["canon-rejected", "core.md"],
      ["canon-rejected", "decisions.md"],
      ["write", "core.md"],
      ["control-canon_approve_all", null],
    ]);
    expect(JSON.parse(results[3].params)).toMatchObject({ reason: "the rules audit", approved: [newer], rejected: [older, stale], failed: [] });
    const version = await env.DB.prepare("SELECT body FROM document_versions WHERE namespace = ?1 AND path = 'core.md' ORDER BY id DESC LIMIT 1").bind(NS).first<{ body: string }>();
    expect(version?.body, "the approval did not snapshot the body it replaced").toBe(CORE);
  });

  it("PLANT: refuses a plan that changed since the preview, and changes nothing", async () => {
    const first = await propose("core.md", "# sample\n\nport 8080");
    const preview = await previewAll();
    // A proposal that arrives after the preview would supersede the one it planned to approve.
    const late = await propose("core.md", "# sample\n\nport 9090");
    const did = await performControl(controlsEnv(), EMAIL, preview.token, null, new Date(), "chat");
    expect(did.ok).toBe(false);
    expect(did.ok ? "" : did.refusal).toMatch(new RegExp(`changed since the preview \\(it planned ${first}:approve; they now plan ${first}:superseded,${late}:approve\\)`));
    expect(await body("core.md")).toBe(CORE);
    expect((await proposals()).map((r) => r.state)).toEqual(["pending", "pending"]);
  });

  it("refuses with nothing pending", async () => {
    const previewed = await previewControl(controlsEnv(), EMAIL, "canon_approve_all", {}, new Date(), "chat");
    expect(previewed.ok ? "" : previewed.refusal).toBe("no pending canon proposals.");
  });
});
