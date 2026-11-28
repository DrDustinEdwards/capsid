import { readDumpJson } from "@dustinedwards/d1-dump";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { BACKUP_CRON, TICK_CRON } from "../src/index";
import { claimJti } from "../src/signed-requests";

// Several crons fire in the 09:00 UTC hour and Cloudflare delivers one invocation per expression, so the handler dispatches
// on controller.cron; test/crons.test.ts checks the lists agree, this runs them against real bindings.

const controller = (cron: string) =>
  ({ cron, scheduledTime: Date.now(), noRetry() {} }) as unknown as ScheduledController;

async function ledger(task: string) {
  const { results } = await env.DB.prepare(
    "SELECT outcome, reason FROM task_runs WHERE task = ?1 ORDER BY id",
  )
    .bind(task)
    .all<{ outcome: string; reason: string }>();
  return results ?? [];
}

async function fire(cron: string) {
  const ctx = createExecutionContext();
  worker.scheduled?.(controller(cron), env, ctx);
  await waitOnExecutionContext(ctx);
}

// The tick with outbound fetch refused at once: the watcher and site pulse probe every live site over the network and pushed
// the tick past this suite's 30 s timeout on a slow runner. A refused read is what a test without credentials meets anyway.
async function fireTickOffline() {
  const offline = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("no network in the integration suite"));
  try {
    await fire(TICK_CRON);
  } finally {
    offline.mockRestore();
  }
}

describe("the three cron expressions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM task_runs").run();
  });

  it("the backup cron writes real dumps to real R2", async () => {
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'cron-fixture.md', 'A document to dump', 'body', 'note', 'published')`,
    ).run();

    await fire(BACKUP_CRON);

    const listed = await env.MEDIA.list();
    expect(listed.objects.length, "the backup cron produced no objects at all").toBeGreaterThan(0);

    // A dump that threw halfway leaves the earlier objects behind and looks like a
    // partial success, so the assertion is on the table this fixture put a row in.
    const documentsDump = listed.objects.find((o: { key: string }) => o.key.includes("documents"));
    expect(
      documentsDump,
      `no documents dump among ${listed.objects.map((o: { key: string }) => o.key).join(", ")}`,
    ).toBeTruthy();
    const dumped = await readDumpJson<unknown>(
      env.MEDIA,
      documentsDump!.key,
      (k) => `no object ${k}`,
    );
    expect(JSON.stringify(dumped)).toContain("cron-fixture.md");

    // One row. Where the backup credential is not configured (CI, and a local run), the
    // dump lands and the prune refuses, and the row says so rather than "ok".
    const runs = await ledger("backup");
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.reason).toMatch(
      run.outcome === "refused"
        ? /^wrote \d+ dump objects, and the prune refused: \S/
        : /^wrote \d+ dump objects \(\d+ documents\); pruned /,
    );
    expect(["ok", "refused"]).toContain(run.outcome);
  });

  it("the tick runs against real bindings and records its run", async () => {
    await fireTickOffline();
    expect(await ledger("tick")).toEqual([
      { outcome: "ok", reason: "the tick's steps ran; each records its own run" },
    ]);
  });

  it("an unrecognized cron expression does no work at all", async () => {
    // The dispatch is on the expression, so a cron added to the config and
    // not to the handler must be inert rather than falling into the backup branch.
    const before = (await env.MEDIA.list()).objects.length;
    await fire("0 0 1 1 *");
    expect((await env.MEDIA.list()).objects.length).toBe(before);
  });

  it("PLANT: a cron branch that throws stays inside its own waitUntil, and the next cron still runs", async () => {
    const planted = new Error("planted MEDIA failure");
    const brokenMedia = new Proxy(
      {},
      {
        get: () => async () => {
          throw planted;
        },
      },
    );
    const broken = { ...env, MEDIA: brokenMedia } as typeof env;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = createExecutionContext();
      expect(() => worker.scheduled?.(controller(BACKUP_CRON), broken, ctx)).not.toThrow();
      await waitOnExecutionContext(ctx).catch(() => {});
      const lines = logged.mock.calls.map((args) => args.map(String).join(" "));
      expect(
        lines.some((l) => l.includes("BACKUP_CRON_THREW") && l.includes("planted MEDIA failure")),
        lines.join(" | "),
      ).toBe(true);
      expect(await ledger("backup")).toEqual([
        { outcome: "threw", reason: "planted MEDIA failure" },
      ]);
    } finally {
      logged.mockRestore();
    }

    await fireTickOffline();
    expect((await ledger("tick")).map((r) => r.outcome)).toEqual(["ok"]);
  });
});

describe("the replay table is real", () => {
  it("PLANT: concurrent claimJti calls for one jti resolve to ONE winner", async () => {
    // A PRIMARY KEY has no get-then-put window, and only real SQLite can show it; a
    // synchronous fake would agree with itself.
    const results = await Promise.all([
      claimJti(env.DB, "backup", "raced"),
      claimJti(env.DB, "backup", "raced"),
      claimJti(env.DB, "backup", "raced"),
    ]);
    expect(
      results.filter((r) => r.ok),
      "exactly one caller may claim a nonce",
    ).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? 0 : r.status))).toEqual([409, 409]);
  });
});
