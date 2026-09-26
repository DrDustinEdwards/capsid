import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";

// required_scopes at the claim and the resume, on the real path. test/jobs-agents.test.ts
// drives `missingForJob` directly, which stays green if the `if (missing)` block is
// dropped. Integration, because "the job stays queued" is a claim about what a real
// keyed UPDATE did.

const SECRET = "test-root-secret";
const SEAT = "github:DrDustinEdwards";
const NOW = new Date("2026-09-13T12:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

// A driver as the roster mints one: its own namespace, write, and no flags. The legacy
// write key holds every flag, so it cannot plant this.
function driver(namespace = "capsid"): Agent {
  const name = `${namespace}-driver`;
  const scopes = defaultScopes([namespace]);
  scopes.grants = ["read", "write"];
  return { id: "agent_0123456789ab", name, kind: "driver", actor: `agent:${name}`, scopes, admin: false, row: null };
}

const SEAT_AGENT = legacyAgent("write", SEAT);

// No cast on purpose: a cast would let a misspelled field (the tool's required_flags
// instead of the function's required_scopes) typecheck and post a job with no
// requirement, and the plants would pass against a bar never set.
async function post(over: Partial<Parameters<typeof postJob>[3]> = {}) {
  return postJob(jobsEnv(), SEAT_AGENT, NOW, {
    namespace: "capsid",
    title: "work that needs a merge flag",
    body: "land the pull request",
    ...over,
  });
}

async function statusOf(id: string) {
  const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1").bind(id).first<{ status: string }>();
  return row?.status;
}

describe("required_scopes on the real queue transitions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM job_outcomes").run();
    // jobs post requires a registered namespace.
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
  });

  it("PLANT: a job naming a flag is not leased to a driver without it, and STAYS QUEUED", async () => {
    const posted = await post({ required_scopes: { flags: ["can_merge"] } });
    const id = posted.job!.id;

    const refused = await claimJob(jobsEnv(), driver(), NOW, { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/can_merge/);
    // Not failed, not parked on a four-hour lease: queued, for a driver that can do it.
    expect(await statusOf(id)).toBe("queued");
  });

  it("THE INNOCENT DIRECTION: a caller holding the flag claims the same job", async () => {
    const posted = await post({ required_scopes: { flags: ["can_merge"] } });
    const won = await claimJob(jobsEnv(), SEAT_AGENT, NOW, { namespace: "capsid" });
    expect(won.ok, won.refusal).toBe(true);
    expect(won.job?.id).toBe(posted.job!.id);
  });

  it("PLANT: a blocked job naming a flag is not RESUMED by a driver without it", async () => {
    // Resume is a claim: the caller ends up holding the lease and doing the rest of
    // the work, so a driver that could not have claimed this job must not acquire it
    // by resuming it.
    const posted = await post({ required_scopes: { flags: ["can_merge"] } });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), SEAT_AGENT, NOW, { namespace: "capsid" });
    await blockJob(jobsEnv(), SEAT_AGENT, NOW, id, { reason: "needs a push", command: "git push" });
    expect(await statusOf(id)).toBe("blocked");

    // take: without it the job goes back to the seat that blocked it, and the driver
    // acquires nothing.
    const refused = await resumeJob(jobsEnv(), driver(), NOW, id, "picking it up", { take: true });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/can_merge/);
    expect(await statusOf(id)).toBe("blocked");

    const returned = await resumeJob(jobsEnv(), driver(), NOW, id, "the push ran");
    expect(returned.ok, returned.refusal).toBe(true);
    expect(returned.job?.claimed_by).toBe(SEAT_AGENT.actor);
  });

  it("PLANT: another namespace's driver cannot resume a job, even to hand it back", async () => {
    // A resume that returns the job to its claimant acquires nothing, so it skips the
    // flag check. It still moves a job, so the namespace is asked either way.
    const posted = await post({ required_scopes: undefined });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), SEAT_AGENT, NOW, { namespace: "capsid" });
    await blockJob(jobsEnv(), SEAT_AGENT, NOW, id, { reason: "needs a push", command: "git push" });
    const refused = await resumeJob(jobsEnv(), driver("foxhound"), NOW, id, "not mine");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/capsid/);
    expect(await statusOf(id)).toBe("blocked");
  });

  it("PLANT: a job scoped to another namespace is not claimed by this namespace's driver", async () => {
    // The other axis missingForJob compares, on the same real path.
    const posted = await post({ required_scopes: { flags: ["can_merge"] } });
    const refused = await claimJob(jobsEnv(), driver("foxhound"), NOW, { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(await statusOf(posted.job!.id)).toBe("queued");
  });
});

// A garbled requirement is not the same as none: a row whose requirement cannot be
// read must not be leased to any driver. Corrupted here by a raw splice, because post
// validates both fields before it writes them.
describe("a corrupt job requirement fails closed at the claim", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("DELETE FROM job_outcomes").run();
    // jobs post requires a registered namespace.
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
  });

  for (const [field, value] of [
    ["required_scopes", "{not json"],
    ["required_scopes", "[]"],
    ["required_scopes", '{"flags":"can_merge"}'],
    ["required_scopes", '{"flags":["can_fly"]}'],
    ["min_record", "{not json"],
    ["min_record", '{"prs_merged":"lots"}'],
  ] as const) {
    it(`PLANT: ${field} = ${value} refuses the claim, names the job and the field, and fails the job`, async () => {
      const posted = await post();
      const id = posted.job!.id;
      await env.DB.prepare(`UPDATE jobs SET ${field} = ?1 WHERE id = ?2`).bind(value, id).run();

      const refused = await claimJob(jobsEnv(), SEAT_AGENT, NOW, { namespace: "capsid" });
      expect(refused.ok, `a job with a corrupt ${field} was leased`).toBe(false);
      expect(refused.refusal).toContain(id);
      expect(refused.refusal).toContain(field);
      // FAILED, not left queued: a claim with no id takes the top queued job, so a
      // corrupt row left queued would refuse every claim in the namespace for good.
      expect(await statusOf(id)).toBe("failed");
    });
  }

  it("a corrupt requirement on a BLOCKED job refuses the resume and leaves it blocked", async () => {
    const posted = await post();
    const id = posted.job!.id;
    await claimJob(jobsEnv(), SEAT_AGENT, NOW, { namespace: "capsid" });
    await blockJob(jobsEnv(), SEAT_AGENT, NOW, id, { reason: "needs a push", command: "git push" });
    await env.DB.prepare("UPDATE jobs SET required_scopes = '{not json' WHERE id = ?1").bind(id).run();

    const refused = await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "picking it up");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toContain("required_scopes");
    expect(await statusOf(id)).toBe("blocked");
  });
});
