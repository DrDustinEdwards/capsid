import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { adminFailJob, blockJob, claimJob, postJob, releaseJob, resumeJob, supersedeJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { GATE_CLASSES, GATE_POLICY_PATH } from "../src/gate-policy";
import { signTaskBody } from "../src/improve-task";

// The human-touch log (migrations/0023, src/job-touches.ts) on a real D1: each
// transition that a person or a policy makes writes its touch in the same guarded batch,
// waited_ms is SQLite's own julianday arithmetic from the latest gate, a transition the
// guard refuses writes no touch, and the table refuses to be rewritten.
//
// job_touches is append-only, so it cannot be emptied between tests the way jobs is:
// every read below is keyed on the job id, and every job is new.

const SECRET = "test-root-secret";
// The admin's Access login: a person, and the seat by its flags.
const ADMIN = legacyAgent("write", "access:admin@example.com");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

function seat(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_aaaabbbbcccc", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

function driver(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

const POLICY = [
  "# Pre-approved gates",
  "",
  "- version: 1",
  "- enabled: true",
  "",
  "## Classes",
  "",
  ...GATE_CLASSES.map((c) => `- \`${c}\` a bounded command.`),
  "",
].join("\n");

const at = (iso: string) => new Date(iso);
const T0 = "2026-09-29T01:00:00.000Z";
const GATE_AT = "2026-09-29T01:30:00.000Z";

let serial = 0;
async function post(): Promise<string> {
  serial += 1;
  const posted = await postJob(jobsEnv(), ADMIN, at(T0), { namespace: "capsid", title: `touch job ${serial} ${Date.now()}`, body: "do the work", gate_required: true });
  expect(posted.ok, posted.refusal).toBe(true);
  return posted.job!.id;
}

async function claimed(): Promise<string> {
  const id = await post();
  const c = await claimJob(jobsEnv(), driver(), at(T0), { id });
  expect(c.ok, c.refusal).toBe(true);
  return id;
}

async function blocked(command = "git push -u origin feat/touch"): Promise<string> {
  const id = await claimed();
  const b = await blockJob(jobsEnv(), driver(), at(GATE_AT), id, { reason: "finished up to the push", command });
  expect(b.ok, b.refusal).toBe(true);
  return id;
}

interface TouchRow {
  id: number;
  kind: string;
  actor: string;
  actor_kind: string;
  waited_ms: number | null;
  detail: string | null;
  at: string;
}

async function touches(id: string): Promise<TouchRow[]> {
  const { results } = await env.DB.prepare("SELECT id, kind, actor, actor_kind, waited_ms, detail, at FROM job_touches WHERE job_id = ?1 ORDER BY id")
    .bind(id)
    .all<TouchRow>();
  return results ?? [];
}

beforeEach(async () => {
  for (const table of ["jobs", "audit_log", "job_outcomes"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
    .run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%' OR path = ?1").bind(GATE_POLICY_PATH).run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, 'gates', ?2, 'procedural', 'published')")
    .bind(GATE_POLICY_PATH, await signTaskBody(SECRET, POLICY))
    .run();
});

describe("job_touches", () => {
  it("block then a seat resume writes a gate, then an approval with the wait since the gate", async () => {
    const id = await blocked();
    const resumed = await resumeJob(jobsEnv(), seat(), at("2026-09-29T01:45:30.250Z"), id, "push approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    const rows = await touches(id);
    expect(rows.map((r) => [r.kind, r.actor, r.actor_kind])).toEqual([
      ["gate", "agent:capsid-driver", "driver"],
      ["approval", "agent:seat", "seat"],
    ]);
    expect(rows[0].waited_ms).toBeNull();
    expect(rows[0].at).toBe(GATE_AT);
    expect(JSON.parse(rows[0].detail ?? "{}")).toEqual({ reason: "finished up to the push", command: "git push -u origin feat/touch" });
    expect(rows[1].waited_ms).toBe(15 * 60 * 1000 + 30_250);
    expect(JSON.parse(rows[1].detail ?? "{}")).toMatchObject({ reason: "push approved", command: "git push -u origin feat/touch" });
  });

  it("the admin's Access login resuming is a human approval", async () => {
    const id = await blocked();
    const resumed = await resumeJob(jobsEnv(), ADMIN, at("2026-09-29T02:30:00.000Z"), id, "approved from the Portal");
    expect(resumed.ok, resumed.refusal).toBe(true);
    const [, approval] = await touches(id);
    expect(approval).toMatchObject({ kind: "approval", actor: "access:admin@example.com", actor_kind: "human", waited_ms: 60 * 60 * 1000 });
  });

  it("a driver's own resume on the gate policy is an approval by policy, naming the class", async () => {
    const id = await blocked("git push -u origin fix/touch && gh pr create --base master --fill");
    const resumed = await resumeJob(jobsEnv(), driver(), at("2026-09-29T01:31:00.000Z"), id, "the gate policy covers a branch push", { approvedByPolicy: "1" });
    expect(resumed.ok, resumed.refusal).toBe(true);
    const [, approval] = await touches(id);
    expect(approval).toMatchObject({ kind: "approval", actor: "agent:capsid-driver", actor_kind: "policy", waited_ms: 60_000 });
    expect(JSON.parse(approval.detail ?? "{}")).toMatchObject({ approved_by_policy: "1", policy_class: "push_branch+open_pr" });
  });

  it("a correction is its own kind, and a note is a separate row with no wait", async () => {
    const id = await blocked();
    const resumed = await resumeJob(jobsEnv(), seat(), at("2026-09-29T02:00:00.000Z"), id, "redo the test", {
      correction: true,
      note: "1. fix the fixture\n2. run it again",
    });
    expect(resumed.ok, resumed.refusal).toBe(true);
    const rows = await touches(id);
    expect(rows.map((r) => r.kind)).toEqual(["gate", "correction", "note"]);
    expect(rows[1]).toMatchObject({ actor_kind: "seat", waited_ms: 30 * 60 * 1000 });
    expect(rows[2]).toMatchObject({ actor: "agent:seat", actor_kind: "seat", waited_ms: null });
    expect(JSON.parse(rows[2].detail ?? "{}")).toEqual({ note: "1. fix the fixture\n2. run it again" });
  });

  it("PLANT: waited_ms is measured from the latest gate, not the first", async () => {
    const id = await blocked();
    expect((await resumeJob(jobsEnv(), seat(), at("2026-09-29T02:00:00.000Z"), id, "first push approved")).ok).toBe(true);
    const again = await blockJob(jobsEnv(), driver(), at("2026-09-29T03:00:00.000Z"), id, { reason: "the second push", command: "git push" });
    expect(again.ok, again.refusal).toBe(true);
    expect((await resumeJob(jobsEnv(), seat(), at("2026-09-29T03:00:05.000Z"), id, "second push approved")).ok).toBe(true);
    const rows = await touches(id);
    expect(rows.map((r) => r.kind)).toEqual(["gate", "approval", "gate", "approval"]);
    // Five seconds since the second gate. Measured from the first it would be 90 minutes.
    expect(rows[3].waited_ms).toBe(5_000);
  });

  it("release, supersede and the seat's fail each write their kind", async () => {
    // Release a job that came back off a gate, so its wait is measured.
    const released = await blocked();
    expect((await resumeJob(jobsEnv(), seat(), at("2026-09-29T02:00:00.000Z"), released, "push approved")).ok).toBe(true);
    const r = await releaseJob(jobsEnv(), seat(), at("2026-09-29T04:00:00.000Z"), released, "the session ended");
    expect(r.ok, r.refusal).toBe(true);
    const releaseRow = (await touches(released)).at(-1);
    // The gate was answered by the resume above, so the release ends no wait of its own.
    expect(releaseRow).toMatchObject({ kind: "release", actor: "agent:seat", actor_kind: "seat", waited_ms: null });
    expect(JSON.parse(releaseRow?.detail ?? "{}")).toMatchObject({ reason: "the session ended", held_by: "agent:capsid-driver" });

    // Supersede a queued job that never hit a gate: no wait to measure.
    const superseded = await post();
    const s = await supersedeJob(jobsEnv(), ADMIN, at("2026-09-29T04:00:00.000Z"), superseded, { reason: "reposted with a corrected body" });
    expect(s.ok, s.refusal).toBe(true);
    expect(await touches(superseded)).toMatchObject([{ kind: "supersede", actor_kind: "human", waited_ms: null }]);

    // The seat failing a blocked job ends the gate's wait.
    const failed = await blocked();
    const f = await adminFailJob(jobsEnv(), seat(), at("2026-09-29T02:30:00.000Z"), failed, "withdrawn");
    expect(f.ok, f.refusal).toBe(true);
    const failRows = await touches(failed);
    expect(failRows.map((t) => t.kind)).toEqual(["gate", "admin_fail"]);
    expect(failRows[1]).toMatchObject({ actor_kind: "seat", waited_ms: 60 * 60 * 1000 });
  });

  it("PLANT: a refused resume writes no touch row", async () => {
    // The claimant approving its own gate is refused before any batch.
    const id = await blocked();
    const refused = await resumeJob(jobsEnv(), driver(), at("2026-09-29T02:00:00.000Z"), id, "I approve myself");
    expect(refused.ok).toBe(false);
    expect((await touches(id)).map((t) => t.kind)).toEqual(["gate"]);
  });

  it("PLANT: a resume the batch guard aborts writes no touch row", async () => {
    // The row moves between resumeJob's read and its batch. requireJobUnchanged, first in
    // the batch, aborts the whole transaction, and the touch with it.
    const id = await blocked();
    const racing = {
      ...jobsEnv(),
      DB: new Proxy(env.DB, {
        get(target, prop, receiver) {
          if (prop !== "batch") {
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare("UPDATE jobs SET updated_at = ?2 WHERE id = ?1").bind(id, "2026-09-29T01:59:59.999Z").run();
            return target.batch(statements);
          };
        },
      }),
    } as unknown as Parameters<typeof postJob>[0];
    const refused = await resumeJob(racing, seat(), at("2026-09-29T02:00:00.000Z"), id, "push approved");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/left blocked between reading it and resuming it|Nothing was written/);
    expect((await touches(id)).map((t) => t.kind)).toEqual(["gate"]);
  });

  it("PLANT: job_touches refuses UPDATE and DELETE", async () => {
    const id = await blocked();
    await expect(env.DB.prepare("UPDATE job_touches SET waited_ms = 0 WHERE job_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM job_touches WHERE job_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    expect(await touches(id)).toHaveLength(1);
  });

  it("the latest-gate lookup reads the (job_id, id) index and sorts nothing", async () => {
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT at FROM job_touches g WHERE g.job_id = ?1 AND g.kind = 'gate' ORDER BY g.id DESC LIMIT 1"
    )
      .bind("x")
      .all<{ detail: string }>();
    const details = (plan.results ?? []).map((r) => r.detail).join(" | ");
    expect(details).toContain("job_touches_job");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
