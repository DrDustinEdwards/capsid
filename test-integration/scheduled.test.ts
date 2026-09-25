import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { BACKUP_CRON, IMPROVE_OPEN_CRON, IMPROVE_TICK_CRON, SKILLS_REFRESH_CRON } from "../src/index";
import { RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../src/improve-schema";
import { activeRun, advanceableRuns } from "../src/improve-state";
import { SCHEDULE_KEY, SKILLS_NAMESPACE, SKILLS_REFRESH_ACTOR, guideKey } from "../src/skills-refresh";

// THE SCHEDULED HANDLER, ALL FOUR CRONS, AGAINST REAL BINDINGS.
//
// Several expressions fire in the 09:00 UTC hour, and Cloudflare delivers the invocation once
// per expression, so the handler dispatches on `controller.cron` rather than on the
// clock. test/improve-cron.test.ts derives the handler's list and the config's list
// from each other; what it cannot do is RUN either of them. This does, which is how
// a cron that dispatches to a branch that throws on a real binding becomes visible.
//
// Every one of these asserts the same shape: the invocation completes, the work it
// was supposed to do is observable in a real store, and the branches it was not
// supposed to take left no trace. A cron that silently does nothing is the failure
// mode the 2026-08-09 outage was made of.

const controller = (cron: string) =>
  ({ cron, scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledController;

async function fire(cron: string) {
  const ctx = createExecutionContext();
  await worker.scheduled?.(controller(cron), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("the four cron expressions", () => {
  it("the backup cron writes real dumps to real R2", async () => {
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'cron-fixture.md', 'A document to dump', 'body', 'note', 'published')`
    ).run();

    await fire(BACKUP_CRON);

    const listed = await env.MEDIA.list();
    expect(listed.objects.length, "the backup cron produced no objects at all").toBeGreaterThan(0);

    // The dump covers every real table, and the list is derived from migrations/ by
    // test/backup.test.ts. What that cannot check is whether SELECT * FROM <table>
    // succeeds against the real schema for each one. A dump that threw halfway
    // leaves the earlier objects behind and looks like a partial success, so the
    // assertion is on the table this fixture put a row in.
    const documentsDump = listed.objects.find((o: { key: string }) => o.key.includes("documents"));
    expect(documentsDump, `no documents dump among ${listed.objects.map((o: { key: string }) => o.key).join(", ")}`).toBeTruthy();
    const dumped = await env.MEDIA.get(documentsDump!.key);
    expect(await dumped!.text()).toContain("cron-fixture.md");
  });

  it("the improve opener runs and writes nothing while the mode is off", async () => {
    // improve_mode falls back to `off` on an unset key, which is the state a fresh
    // store is in. The opener must complete and open nothing: an unreadable KV that
    // starts writing to five repos is the failure this default exists to stop.
    await fire(IMPROVE_OPEN_CRON);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM improve_runs").first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  it("the improve tick runs against real improve tables and advances nothing when there is nothing to advance", async () => {
    await fire(IMPROVE_TICK_CRON);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM improve_runs").first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });

  // THE SKILLS REFRESH, added 2026-09-17: it was the fourth expression and this file
  // fired only three, so a refresh that threw against a real binding was invisible.
  // It fires daily and gates on its weekday inside the handler, so both halves are
  // driven: the skip, which reads only real KV, and the run, which posts a job into
  // real D1. The two docs fetches are stubbed; the network is not what is under test.
  const skillsJobs = () =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE namespace = ?1 AND posted_by = ?2")
      .bind(SKILLS_NAMESPACE, SKILLS_REFRESH_ACTOR)
      .first<{ n: number }>();

  it("the skills refresh skips on any other weekday and writes nothing", async () => {
    const otherDay = (new Date().getUTCDay() + 1) % 7;
    await env.APP_KV.put(SCHEDULE_KEY, JSON.stringify({ enabled: true, dayUtc: otherDay }));
    await fire(SKILLS_REFRESH_CRON);
    expect((await skillsJobs())?.n).toBe(0);
    expect(await env.APP_KV.get(guideKey("fable-5-1"))).toBeNull();
  });

  it("the skills refresh on its weekday posts a real job and records the guide it saw", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, '[]')").bind(SKILLS_NAMESPACE).run();
    await env.APP_KV.put(SCHEDULE_KEY, JSON.stringify({ enabled: true, dayUtc: new Date().getUTCDay() }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/models/overview.md")) return new Response("Models: claude-fable-5-1 is the newest.");
      if (url.endsWith("/prompting-claude-fable-5-1.md")) return new Response("guide text");
      return new Response("not stubbed", { status: 500 });
    });
    try {
      await fire(SKILLS_REFRESH_CRON);
    } finally {
      fetchSpy.mockRestore();
    }
    expect((await skillsJobs())?.n).toBe(1);
    expect(await env.APP_KV.get(guideKey("fable-5-1"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an unrecognised cron expression does no work at all", async () => {
    // The dispatch is on the expression, so a cron added to the config and
    // not to the handler must be inert rather than falling into the backup branch.
    const before = (await env.MEDIA.list()).objects.length;
    await fire("0 0 1 1 *");
    expect((await env.MEDIA.list()).objects.length).toBe(before);
  });
});

describe("the improve schema is real", () => {
  it("the jti replay cache really has a PRIMARY KEY, so a duplicate claim conflicts", async () => {
    // migrations/0004_improve_jti.sql. The unit suite proves the statement is
    // `INSERT ... ON CONFLICT DO NOTHING RETURNING`; only a real database proves
    // the conflict happens, and the whole replay defence rests on it.
    const first = await env.DB.prepare(
      "INSERT INTO improve_jti (scope, jti, seen_at) VALUES ('capsid', 'dup', datetime('now')) ON CONFLICT DO NOTHING RETURNING jti"
    ).first<{ jti: string }>();
    expect(first?.jti).toBe("dup");

    const second = await env.DB.prepare(
      "INSERT INTO improve_jti (scope, jti, seen_at) VALUES ('capsid', 'dup', datetime('now')) ON CONFLICT DO NOTHING RETURNING jti"
    ).first<{ jti: string }>();
    expect(second, "the second claim must return nothing; if it returns a row the replay cache is decorative").toBeNull();
  });

  it("the one-active-run partial unique index really refuses a second open run", async () => {
    await env.DB.prepare(
      `INSERT INTO improve_runs (id, namespace, mode, status, started, condition)
       VALUES ('r-one', 'capsid', 'subscription', 'open', datetime('now'), 'full')`
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO improve_runs (id, namespace, mode, status, started, condition)
         VALUES ('r-two', 'capsid', 'subscription', 'open', datetime('now'), 'full')`
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM improve_runs WHERE id = 'r-one'").run();
  });
});

describe("the improve state machine's terminal set", () => {
  // activeRun and advanceableRuns decide what the tick advances. Both must treat
  // exactly TERMINAL_RUN_STATUSES as finished, or a finished run is advanced again or
  // a live one is left behind.
  it("a run in a terminal status is neither active nor advanceable, and every other status is both", async () => {
    await env.DB.prepare("DELETE FROM improve_runs").run();
    for (const status of RUN_STATUSES) {
      await env.DB.prepare("INSERT INTO improve_runs (id, namespace, mode, status) VALUES (?1, ?2, 'api', ?3)")
        .bind(`run-${status}`, `ns-${status}`, status)
        .run();
    }
    const terminal = new Set<string>(TERMINAL_RUN_STATUSES);
    const advanceable = (await advanceableRuns(env.DB as never, 100)).map((r) => r.status).sort();
    expect(advanceable).toEqual(RUN_STATUSES.filter((s) => !terminal.has(s)).sort());
    for (const status of RUN_STATUSES) {
      const active = await activeRun(env.DB as never, `ns-${status}`);
      expect(active === null, `activeRun for a ${status} run`).toBe(terminal.has(status));
    }
    await env.DB.prepare("DELETE FROM improve_runs").run();
  });
});
