import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, completeJob, postJob, resumeJob } from "../src/jobs";
import { legacyAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { GATE_CLASSES, GATE_POLICY_PATH } from "../src/gate-policy";
import { signTaskBody } from "../src/improve-task";

// RULED 2026-09-16: THE DRIVER PUSHES ITS OWN BRANCH AND OPENS ITS OWN PULL REQUEST.
//
// On a real D1: a driver claims a job, reaches a branch push, blocks with the command,
// and sends the job back in on the signed gate policy with no human in between. The
// audit row must name the class, the job must stay the driver's, and the outcome
// must count the whole working life. The force-push plant runs the same path and
// must leave the job blocked for the human.

const SECRET = "test-root-secret";
const SEAT = legacyAgent("write", "github:DrDustinEdwards");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

// A driver as the roster mints one: its own namespace, write, and not one flag.
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

async function blockedAtPush(title: string, command: string): Promise<string> {
  const posted = await postJob(jobsEnv(), SEAT, at("2026-09-17T01:00:00.000Z"), { namespace: "capsid", title, body: "do the work", gate_required: true });
  const id = posted.job!.id;
  const claimed = await claimJob(jobsEnv(), driver(), at("2026-09-17T01:00:00.000Z"), { id });
  expect(claimed.ok, claimed.refusal).toBe(true);
  const blocked = await blockJob(jobsEnv(), driver(), at("2026-09-17T01:30:00.000Z"), id, { reason: "finished up to the push", command });
  expect(blocked.ok, blocked.refusal).toBe(true);
  return id;
}

async function jobRow(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function resumedAudit(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT actor, params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1 AND params LIKE '%approved%' ORDER BY id"
  )
    .bind(`%${id}%`)
    .all<{ actor: string; params: string }>();
  return (results ?? []).map((r) => ({ actor: r.actor, ...(JSON.parse(r.params) as Record<string, unknown>) }));
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM job_outcomes").run();
  // jobs post requires a registered namespace (audit 2026-09-25, F2-8).
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%' OR path = ?1").bind(GATE_POLICY_PATH).run();
  await env.DB.prepare("INSERT INTO documents (namespace, path, title, body, type, status) VALUES ('capsid', ?1, 'gates', ?2, 'procedural', 'published')")
    .bind(GATE_POLICY_PATH, await signTaskBody(SECRET, POLICY))
    .run();
});

describe("a driver approves its own branch push on the gate policy", () => {
  it("push_branch block, driver-side resume, audit row naming the class, outcome from the first claim", async () => {
    const id = await blockedAtPush("self-approved push", "git push -u origin fix/driver-policy-resume && gh pr create --base master --fill");

    const resumed = await resumeJob(jobsEnv(), driver(), at("2026-09-17T01:31:00.000Z"), id, "the gate policy covers a branch push and a pull request", {
      approvedByPolicy: "1",
    });
    expect(resumed.ok, resumed.refusal).toBe(true);

    const row = await jobRow(id);
    expect(row?.status).toBe("claimed");
    expect(row?.claimed_by).toBe("agent:capsid-driver");
    expect(row?.claimed_at).toBe("2026-09-17T01:00:00.000Z");
    expect(row?.corrections_count).toBe(0);

    const audits = await resumedAudit(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: "agent:capsid-driver",
      approved_by_policy: "1",
      policy_class: "push_branch+open_pr",
      held_by: "agent:capsid-driver",
    });

    const done = await completeJob(jobsEnv(), driver(), at("2026-09-17T01:45:00.000Z"), id, { result_summary: "pushed and opened" });
    expect(done.ok, done.refusal).toBe(true);
    expect(done.outcome?.row.duration_minutes).toBe(45);
  });

  it("PLANT: a force push takes the same path and is refused, leaving the job blocked for the human", async () => {
    const id = await blockedAtPush("forced push", "git push --force origin fix/driver-policy-resume");
    const refused = await resumeJob(jobsEnv(), driver(), at("2026-09-17T01:31:00.000Z"), id, "the gate policy covers a branch push", {
      approvedByPolicy: "1",
    });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/never list because it force-pushes/);
    const row = await jobRow(id);
    expect(row?.status).toBe("blocked");
    expect(row?.resumed_count).toBe(0);
    expect(await resumedAudit(id)).toHaveLength(0);
  });
});
