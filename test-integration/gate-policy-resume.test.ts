import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { GATE_CLASSES, GATE_POLICY_PATH } from "../src/gate-policy";
import { signTaskBody } from "../src/improve-task";

// The gate policy's resume path, against a real D1. Every job is posted, claimed and
// blocked through the real queue, the policy document is a real signed row, and every
// assertion reads the jobs and audit_log rows back. The classifier itself is tested
// in test/gate-policy.test.ts, where it is pure.

const SECRET = "test-improve-secret";
const SEAT_POSTER = legacyAgent("write", "github:DrDustinEdwards");
const REPO = "DrDustinEdwards/capsid-mcp";

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

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

// The seat as it is minted: write, and can_merge, the flag no driver holds.
function seatAgent(): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  scopes.flags.can_merge = true;
  return { id: "agent_aaaabbbbcccc", name: "seat", kind: "seat", actor: "agent:seat", scopes, admin: false, row: null };
}

// A roster driver: one namespace, write, and not one flag.
function driverAgent(actor = "agent:capsid-driver"): Agent {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_ddddeeeeffff", name: actor.slice("agent:".length), kind: "driver", actor, scopes, admin: false, row: null };
}

const at = (iso: string) => new Date(iso);
let serial = 0;

// A job the claimant took and blocked on `command`. The queue is emptied first, so a
// loop that calls this once per case starts every case from the same state.
async function blockedJob(command: string, claimant: Agent = driverAgent()): Promise<string> {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  serial += 1;
  const posted = await postJob(jobsEnv(), SEAT_POSTER, at("2026-09-11T22:00:00.000Z"), {
    namespace: "capsid",
    title: `a job that hit a gate ${serial}`,
    body: "Do the thing.",
    gate_required: true,
  });
  expect(posted.ok, posted.refusal).toBe(true);
  const id = posted.job!.id;
  const claimed = await claimJob(jobsEnv(), claimant, at("2026-09-12T00:00:00.000Z"), { id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  const blocked = await blockJob(jobsEnv(), claimant, at("2026-09-12T00:00:00.000Z"), id, { reason: "Finished up to the push.", command });
  expect(blocked.ok, blocked.refusal).toBe(true);
  return id;
}

async function jobRow(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

// The mirror document write audits under the same action name, so this picks the job
// row's audit entry, the one carrying `approved`.
async function approvalRow(id: string): Promise<Record<string, unknown> | null> {
  const { results } = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1 ORDER BY id")
    .bind(`%${id}%`)
    .all<{ params: string }>();
  for (const r of results ?? []) {
    const parsed = JSON.parse(r.params) as Record<string, unknown>;
    if ("approved" in parsed) return parsed;
  }
  return null;
}

// A refused resume leaves the row exactly as the block left it.
async function expectUntouched(id: string, before: Record<string, unknown> | null) {
  const after = await jobRow(id);
  expect(after?.status).toBe("blocked");
  expect(after, "a refused resume moved the row").toEqual(before);
  expect(await approvalRow(id), "a refused resume wrote an approval row").toBeNull();
}

beforeEach(async () => {
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
    .bind("capsid", JSON.stringify([{ repo: REPO, label: "primary" }]))
    .run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%' OR path = ?1").bind(GATE_POLICY_PATH).run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, 'gates', ?2, 'procedural', 'published')")
    .bind(GATE_POLICY_PATH, await signTaskBody(SECRET, POLICY))
    .run();
});

describe("the audit row of a policy resume", () => {
  it("a policy-approved resume records which class matched and what it matched on", async () => {
    const id = await blockedJob("git push -u origin feat/autonomy-policy-gates");
    const result = await resumeJob(jobsEnv(), seatAgent(), at("2026-09-12T03:00:00Z"), id, "pre-approved branch push", { approvedByPolicy: "1" });
    expect(result.ok, result.refusal).toBe(true);
    const row = await approvalRow(id);
    expect(row, "a policy-approved resume must still write its audit row").toBeTruthy();
    expect(row).toMatchObject({
      approved_by_policy: "1",
      policy_class: "push_branch",
      policy_detail: "git push -u origin feat/autonomy-policy-gates",
      approved: "pre-approved branch push",
    });
  });

  it("a resume with no policy records no policy fields, so the two cases are distinguishable", async () => {
    const id = await blockedJob("git push -u origin feat/x");
    const result = await resumeJob(jobsEnv(), seatAgent(), at("2026-09-12T03:00:00Z"), id, "the human said yes");
    expect(result.ok, result.refusal).toBe(true);
    const row = await approvalRow(id);
    expect(row).toBeTruthy();
    expect(row?.approved_by_policy, "a human-approved resume must not look policy-approved").toBeUndefined();
    expect(row?.policy_class).toBeUndefined();
  });

  it("a command on the never list refuses the resume and leaves the job blocked", async () => {
    const id = await blockedJob("npx wrangler secret put IMPROVE_SCORE_SECRET");
    const before = await jobRow(id);
    const result = await resumeJob(jobsEnv(), seatAgent(), at("2026-09-12T03:00:00Z"), id, "trying it on", { approvedByPolicy: "1" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/not pre-approved/);
    await expectUntouched(id, before);
  });
});

// A driver may policy-approve its own branch push and pull request, and nothing else:
// a migration, a force push, somebody else's job and an unclassified command all wait.

async function driverResume(command: string, opts: { claimant?: Agent; take?: boolean } = {}) {
  const id = await blockedJob(command, opts.claimant ?? driverAgent());
  const before = await jobRow(id);
  const result = await resumeJob(jobsEnv(), driverAgent(), at("2026-09-12T03:00:00Z"), id, "the policy covers it", {
    approvedByPolicy: "1",
    take: opts.take,
  });
  return { id, before, result };
}

describe("a driver's policy resume", () => {
  it("a DRIVER approves its own branch push, and the audit row names the class", async () => {
    const { id, result } = await driverResume("git push -u origin fix/driver-policy-resume");
    expect(result.ok, `the driver was refused its own branch push: ${JSON.stringify(result)}`).toBe(true);
    const row = await jobRow(id);
    expect(row?.status).toBe("claimed");
    expect(row?.claimed_by).toBe("agent:capsid-driver");
    expect(await approvalRow(id)).toMatchObject({
      approved_by_policy: "1",
      policy_class: "push_branch",
      policy_detail: "git push -u origin fix/driver-policy-resume",
    });
  });

  it("a DRIVER approves the push and the pull request together", async () => {
    const { id, result } = await driverResume('git push -u origin feat/x && gh pr create --base master --title "t" --fill');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await approvalRow(id))?.policy_class).toBe("push_branch+open_pr");
  });

  it("PLANT: a DRIVER's force push is refused and the job stays blocked for the human", async () => {
    for (const command of ["git push --force origin feat/x", "git push -f origin feat/x", "git push --force-with-lease origin feat/x"]) {
      const { id, before, result } = await driverResume(command);
      expect(result.ok, `${command} was self-approved`).toBe(false);
      expect(String(result.refusal)).toMatch(/never list/);
      await expectUntouched(id, before);
    }
  });

  it("PLANT: a DRIVER's push to a default branch is refused", async () => {
    const { id, before, result } = await driverResume("git push origin master");
    expect(result.ok, "a push to master was self-approved").toBe(false);
    await expectUntouched(id, before);
  });

  it("PLANT: a DRIVER may not approve a migration, which the ruling keeps human", async () => {
    const { id, before, result } = await driverResume("npx wrangler d1 execute capsid --remote --file migrations/0019_x.sql");
    expect(result.ok, "a driver approved a migration").toBe(false);
    expect(String(result.refusal)).toMatch(/matched additive_migration, which a driver may not approve/);
    await expectUntouched(id, before);
  });

  it("PLANT: a DRIVER may not approve a command that classifies as nothing", async () => {
    const { id, before, result } = await driverResume("npm run deploy");
    expect(result.ok, "an unclassified command was self-approved").toBe(false);
    expect(String(result.refusal)).toMatch(/matches no pre-approved class/);
    await expectUntouched(id, before);
  });

  it("PLANT: a DRIVER may not approve a job another agent blocked, nor take one on the policy", async () => {
    const other = await driverResume("git push -u origin feat/x", { claimant: driverAgent("agent:foxing-driver") });
    expect(other.result.ok, "a driver approved another driver's push").toBe(false);
    expect(String(other.result.refusal)).toMatch(/may approve only a job it blocked itself/);
    await expectUntouched(other.id, other.before);

    const taken = await driverResume("git push -u origin feat/x", { take: true });
    expect(taken.result.ok, "a driver took and approved in one call").toBe(false);
    await expectUntouched(taken.id, taken.before);
  });

  it("a SEAT's policy approval returns the job to the driver that blocked it", async () => {
    const id = await blockedJob("git push -u origin feat/x");
    const result = await resumeJob(jobsEnv(), seatAgent(), at("2026-09-12T03:00:00Z"), id, "approved", { approvedByPolicy: "1" });
    expect(result.ok, `the seat was refused its own policy: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow(id))?.claimed_by, "the seat took the job it approved").toBe("agent:capsid-driver");
  });
});

// The claimant's own plain resume. A plain resume records "approved: <reason>" in the
// audit row, which reads as a human approval, so the claimant may not write it for
// itself unless it is the admin or holds can_merge. Other write-grant callers still can.

async function plainResume(agent: Agent, command: string, opts: { take?: boolean } = {}) {
  const id = await blockedJob(command);
  const before = await jobRow(id);
  const result = await resumeJob(jobsEnv(), agent, at("2026-09-12T03:00:00Z"), id, "the human ran it", { take: opts.take });
  return { id, before, result };
}

describe("a plain resume", () => {
  it("PLANT: a DRIVER may not resume its own blocked job with a plain resume", async () => {
    for (const command of ["npm run deploy", "npx wrangler secret put IMPROVE_SCORE_SECRET", "git push --force origin feat/x", "git push -u origin feat/x"]) {
      for (const take of [false, true]) {
        const { id, before, result } = await plainResume(driverAgent(), command, { take });
        expect(result.ok, `the claimant resumed its own block on '${command}' (take: ${take})`).toBe(false);
        expect(String(result.refusal)).toMatch(/cannot approve its own gate/);
        expect(String(result.refusal), "the refusal must say who can resume it").toMatch(/admin or can_merge/);
        await expectUntouched(id, before);
      }
    }
  });

  it("the SEAT and the ADMIN may resume the driver's job, and it goes back to the driver", async () => {
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    const admin: Agent = { ...seatAgent(), name: "admin", actor: "github:DrDustinEdwards", admin: true, scopes };
    for (const agent of [seatAgent(), admin]) {
      const { id, result } = await plainResume(agent, "npm run deploy");
      expect(result.ok, `${agent.actor} was refused: ${JSON.stringify(result)}`).toBe(true);
      expect((await jobRow(id))?.claimed_by).toBe("agent:capsid-driver");
      expect((await approvalRow(id))?.approved).toBe("the human ran it");
    }
  });

  it("a SEAT or ADMIN that is itself the claimant may still resume its own job", async () => {
    // The exception is for the caller that can approve gates in the first place.
    const { result } = await plainResume({ ...seatAgent(), actor: "agent:capsid-driver" }, "npm run deploy");
    expect(result.ok, `a can_merge claimant was refused: ${JSON.stringify(result)}`).toBe(true);
  });

  it("a DIFFERENT write-grant caller may still resume, and the job goes back to its claimant", async () => {
    const { id, result } = await plainResume(driverAgent("agent:other-driver"), "npm run deploy");
    expect(result.ok, `another write-grant caller was refused: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow(id))?.claimed_by).toBe("agent:capsid-driver");
  });
});

// a migration is read at the job's own pull request head

const JOB_PR = `https://github.com/${REPO}/pull/40`;
const JOB_HEAD = "1234567890abcdef1234567890abcdef12345678";
const MIGRATION_19 = "npx wrangler d1 execute capsid --remote --file migrations/0019_x.sql";

// A fake GitHub holding the file at two places: the job's pull request head and the
// default branch. Records every contents read, with its ref.
function githubWithMigrationAt(files: { head: string | null; defaultBranch: string | null }): string[] {
  const reads: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === `/repos/${REPO}/pulls/40`) return json({ head: { sha: JOB_HEAD } });
    if (url.pathname === `/repos/${REPO}/contents/migrations/0019_x.sql`) {
      const ref = url.searchParams.get("ref");
      reads.push(ref ?? "(default branch)");
      const body = ref === JOB_HEAD ? files.head : ref === null ? files.defaultBranch : null;
      if (body === null) return json({ message: "Not Found" }, 404);
      return json({ type: "file", encoding: "base64", content: btoa(body), size: body.length, sha: "f".repeat(40) });
    }
    return new Response("not modelled", { status: 404 });
  });
  return reads;
}

async function seatMigrationResume(resultRef: string | null) {
  // The installation token, cached as the client caches it, so no App JWT is minted.
  await env.APP_KV.put(`gh:token:v3:${REPO}`, "test-token");
  const cached = await env.APP_KV.list({ prefix: "gh:get:" });
  for (const key of cached.keys) await env.APP_KV.delete(key.name);
  const id = await blockedJob(MIGRATION_19);
  await env.DB.prepare("UPDATE jobs SET result_ref = ?2 WHERE id = ?1").bind(id, resultRef).run();
  const before = await jobRow(id);
  const result = await resumeJob(jobsEnv(), seatAgent(), at("2026-09-12T03:00:00Z"), id, "additive", { approvedByPolicy: "1" });
  return { id, before, result };
}

describe("a migration resume", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PLANT: a migration that exists only on the job's branch is read there and approved", async () => {
    // Absent from the default branch, which is the normal state of a new migration.
    const reads = githubWithMigrationAt({ head: "CREATE TABLE IF NOT EXISTS x (a TEXT);", defaultBranch: null });
    const { id, result } = await seatMigrationResume(JOB_PR);
    expect(result.ok, `the job's own migration was refused: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow(id))?.status).toBe("claimed");
    expect(reads).toEqual([JOB_HEAD]);
  });

  it("PLANT: a same-named migration on the default branch does not approve the one at the job's head", async () => {
    const reads = githubWithMigrationAt({ head: "DROP TABLE jobs;", defaultBranch: "CREATE TABLE IF NOT EXISTS x (a TEXT);" });
    const { id, before, result } = await seatMigrationResume(JOB_PR);
    expect(result.ok, "the default branch's file approved the job's destructive one").toBe(false);
    expect(String(result.refusal)).toMatch(/does not call additive/);
    await expectUntouched(id, before);
    expect(reads).toEqual([JOB_HEAD]);
  });

  it("a migration resume on a job that records no pull request is refused and says why", async () => {
    const reads = githubWithMigrationAt({ head: null, defaultBranch: "CREATE TABLE IF NOT EXISTS x (a TEXT);" });
    const { id, before, result } = await seatMigrationResume(null);
    expect(result.ok).toBe(false);
    expect(String(result.refusal)).toMatch(/records no pull request/);
    await expectUntouched(id, before);
    expect(reads, "the default branch was read anyway").toEqual([]);
  });
});
