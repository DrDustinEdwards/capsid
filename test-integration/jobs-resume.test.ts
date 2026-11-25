import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, jobsSummary, listJobs, releaseJob, resumeJob } from "../src/jobs";
import { grantAgent, type Agent } from "../src/agents";
import { defaultScopes } from "../src/agents-schema";
import { CORRECTION_CAP, RETRY_CAP_REASON, jobDocPath } from "../src/jobs-schema";
import { MAX_TITLE } from "../src/limits";
import {
  post,
  resetJobs,
  SEAT,
  DRIVER,
  NOW,
  jobRow,
  jobsEnv,
  driverBlockedJob,
} from "./jobs-fixture";

beforeEach(resetJobs);

describe("the resume note", () => {
  const SEAT_AGENT = grantAgent("write", SEAT);
  // A driver as the roster mints one: its own namespace, write, and no flags.
  function agentDriver(): Agent {
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    return {
      id: "agent_0123456789ab",
      name: "capsid-driver",
      kind: "driver",
      actor: "agent:capsid-driver",
      scopes,
      admin: false,
      row: null,
    };
  }

  async function releasedThenClaimed(id: string) {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect((await releaseJob(jobsEnv(), SEAT_AGENT, later, id, "the holder is gone")).ok).toBe(
      true,
    );
    const claimed = await claimJob(jobsEnv(), agentDriver(), later, { namespace: "capsid", id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    return claimed;
  }

  it("the seat resumes, releases the claim, and a driver's claim carries the seat's note", async () => {
    const id = await driverBlockedJob("note reaches the next claim");
    const resumed = await resumeJob(
      jobsEnv(),
      SEAT_AGENT,
      NOW,
      id,
      "answers: use option B; batches 1 and 2 approved",
    );
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect(resumed.resume_note?.reason).toBe("answers: use option B; batches 1 and 2 approved");
    expect(resumed.resume_note?.by).toBe(SEAT);

    const claimed = await releasedThenClaimed(id);
    expect(claimed.resume_note?.reason).toBe("answers: use option B; batches 1 and 2 approved");
    expect(claimed.resume_note?.by).toBe(SEAT);
  });

  // A question block: the session asks, the Worker fixes the command, every reader can tell it from a gate,
  // and the answer is a resume note the driver keeps.
  async function claimedJob(title: string) {
    const posted = await post({ title });
    const id = posted.job!.id;
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
    return id;
  }
  const blockedRow = async (id: string) =>
    (await jobsSummary(env.DB, "capsid", NOW)).blocked_jobs.find((j) => j.id === id);

  it("a question block asks with the Worker's fixed command, and improve_status marks it a question while a gate is not", async () => {
    const asking = await claimedJob("a question is asked");
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, asking, {
      reason: "Keep the old route or the new one for /health?",
      question: true,
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    expect(blocked.job?.status).toBe("blocked");
    expect(blocked.job?.result_summary).toMatch(
      /^QUESTION: Keep the old route or the new one for \/health\?/,
    );
    expect(blocked.job?.result_summary).toContain("Answer in a resume note");
    expect((await blockedRow(asking))?.question).toBe(true);

    const gate = await claimedJob("a gate is hit");
    await blockJob(jobsEnv(), DRIVER, NOW, gate, {
      reason: "needs a push",
      command: "git push origin feat/x",
    });
    expect((await blockedRow(gate))?.question).toBe(false);
  });

  it("PLANT: a question block that carries its own command is refused, and the job stays claimed", async () => {
    const id = await claimedJob("a question with a command");
    const refused = await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "which one?",
      question: true,
      command: "rm -rf /",
    });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/takes no command/);
    expect((await listJobs(jobsEnv(), { namespace: "capsid", id })).jobs?.[0]?.status).toBe(
      "claimed",
    );
    const empty = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "  ", question: true });
    expect(empty.ok).toBe(false);
    expect(empty.refusal).toMatch(/needs the question/);
  });

  it("the seat answers with a resume note, and the driver reads it on list and on every later claim", async () => {
    const id = await claimedJob("a question is answered");
    await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "Which route do I keep?",
      question: true,
    });
    const answered = await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "keep the old route", {
      note: "Keep /health as it is; add /ready beside it.",
    });
    expect(answered.ok, answered.refusal).toBe(true);
    const beat = await listJobs(jobsEnv(), { namespace: "capsid", id: id });
    expect(beat.resume_notes?.map((n) => n.reason)).toEqual(["keep the old route"]);
    expect(beat.resume_notes?.[0]?.note).toContain("add /ready beside it");
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "And the metrics path?", question: true });
    await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "leave metrics out");
    const later = await listJobs(jobsEnv(), { namespace: "capsid", id: id });
    expect(later.resume_notes?.map((n) => n.reason)).toEqual([
      "leave metrics out",
      "keep the old route",
    ]);
  });

  // Every resume note, not only the latest: an approval given at one resume is still there after the next.
  async function resumedThrice(title: string) {
    const id = await driverBlockedJob(title);
    for (const reason of [
      "first ruling: use option B",
      "second ruling: keep the old route",
      "third ruling: merge in PR order",
    ]) {
      const resumed = await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, reason);
      expect(resumed.ok, resumed.refusal).toBe(true);
      await blockJob(jobsEnv(), DRIVER, NOW, id, {
        reason: "another question",
        command: "git push origin feat/x",
      });
    }
    return id;
  }
  const REASONS = [
    "third ruling: merge in PR order",
    "second ruling: keep the old route",
    "first ruling: use option B",
  ];

  it("claim and list return every resume note, newest first, with resume_note still the newest", async () => {
    const id = await resumedThrice("every note reaches the next claim");
    // The last block left it blocked, so resume once more to put a driver back on it.
    await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, "fourth ruling: ship it");
    const all = ["fourth ruling: ship it", ...REASONS];

    const beat = await listJobs(jobsEnv(), { namespace: "capsid", id: id });
    expect(beat.resume_notes?.map((n) => n.reason)).toEqual(all);
    expect(beat.resume_note?.reason).toBe(all[0]);
    expect(beat.resume_notes_dropped).toBeUndefined();

    const listed = await listJobs(jobsEnv(), { namespace: "capsid", id });
    expect(listed.resume_notes?.map((n) => n.reason)).toEqual(all);

    const claimed = await releasedThenClaimed(id);
    expect(claimed.resume_notes?.map((n) => n.reason)).toEqual(all);
    expect(claimed.resume_notes?.every((n) => n.signature === "verified")).toBe(true);
  });

  it("the mirrored document lists the earlier resumes under the last one", async () => {
    const id = await resumedThrice("every note in the mirror");
    const doc = await env.DB.prepare(
      "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    const body = doc?.body ?? "";
    expect(body).toContain(`last resume, by ${SEAT}`);
    expect(body).toContain("## Earlier resumes");
    for (const reason of REASONS) expect(body, reason).toContain(reason);
    expect(body.indexOf("second ruling")).toBeLessThan(body.indexOf("first ruling"));
  });

  it("the notes are capped at 64 KB, the oldest dropped and counted, the newest always kept", async () => {
    const id = await driverBlockedJob("notes past the cap");
    const big = (n: number) => `ruling ${n}: ` + "x".repeat(15_000);
    for (let n = 1; n <= 6; n++) {
      await resumeJob(jobsEnv(), SEAT_AGENT, NOW, id, `note ${n}`, { note: big(n) });
      if (n < 6)
        await blockJob(jobsEnv(), DRIVER, NOW, id, {
          reason: "again",
          command: "git push origin feat/x",
        });
    }
    const beat = await listJobs(jobsEnv(), { namespace: "capsid", id: id });
    const sent = beat.resume_notes ?? [];
    expect(sent.length).toBeLessThan(6);
    expect(sent[0]?.reason).toBe("note 6");
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(64 * 1024);
    expect(beat.resume_notes_dropped).toBe(6 - sent.length);
    expect(sent.map((n) => n.reason)).toEqual(
      ["note 6", "note 5", "note 4", "note 3", "note 2"].slice(0, sent.length),
    );
  });

  // The full note. reason is bounded at MAX_TITLE; note carries an approval with
  // rulings or a plan in full.
  const LONG_NOTE = [
    "Approved the whole report. The six rulings, in order:",
    ...Array.from(
      { length: 6 },
      (_, i) =>
        `${i + 1}. Ruling ${i + 1}: keep the existing route for item ${i + 1}, add a behavior test that fails without the change, and open one pull request per item so each can be reviewed and merged on its own schedule.`,
    ),
    "",
    "Plan: work the items in the order above. Stop at the first gate and block with the exact command. Do not merge anything; the seat merges.",
    "Last paragraph, the one a truncation would lose: the sixth ruling outranks the report where they disagree.",
  ].join("\n");

  it("a note longer than a reason reaches resume, claim, list and the mirror in full", async () => {
    expect(LONG_NOTE.length).toBeGreaterThan(MAX_TITLE);
    const id = await driverBlockedJob("full note reaches everyone");
    const resumed = await resumeJob(
      jobsEnv(),
      SEAT_AGENT,
      NOW,
      id,
      "approved the report and gave the six rulings",
      {
        note: LONG_NOTE,
      },
    );
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect(resumed.resume_note?.reason).toBe("approved the report and gave the six rulings");
    expect(resumed.resume_note?.note).toBe(LONG_NOTE);

    const beat = await listJobs(jobsEnv(), { namespace: "capsid", id: id });
    expect(beat.ok, beat.refusal).toBe(true);
    expect(beat.resume_note?.note).toBe(LONG_NOTE);

    expect((await listJobs(jobsEnv(), { namespace: "capsid", id })).resume_note?.note).toBe(
      LONG_NOTE,
    );

    const doc = await env.DB.prepare(
      "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(doc?.body).toContain(LONG_NOTE);

    const claimed = await releasedThenClaimed(id);
    expect(claimed.resume_note?.note).toBe(LONG_NOTE);

    const after = await env.DB.prepare(
      "SELECT body FROM documents WHERE namespace = 'capsid' AND path = ?1",
    )
      .bind(jobDocPath(id))
      .first<{ body: string }>();
    expect(after?.body).toContain(LONG_NOTE);
  });
});

describe("the retry cap, where the block is written", () => {
  async function blockedAt(corrections: number, title: string) {
    const posted = await post({ title });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid", id });
    await env.DB.prepare("UPDATE jobs SET corrections_count = ?1 WHERE id = ?2")
      .bind(corrections, id)
      .run();
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "needs a human",
      command: "git push -u origin feat/x",
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    return String((await jobRow(id))?.result_summary);
  }

  it("a block at the cap says so in the summary and keeps what the driver said; one under the cap does not", async () => {
    const atCap = await blockedAt(CORRECTION_CAP, "at the cap");
    expect(atCap).toContain(RETRY_CAP_REASON);
    expect(atCap).toContain("needs a human");
    expect(await blockedAt(CORRECTION_CAP - 1, "under the cap")).not.toContain(RETRY_CAP_REASON);
  });
});

describe("the retry cap, where resume reads it", () => {
  // Named agents, not the legacy key (it resolves to the admin, the one caller the cap lets through); the resumer is a can_merge seat,
  // because a driver's plain resume is refused before the cap is read. SQLite sums corrections_count over (namespace, title).
  function agentNamed(name: string, admin = false, canMerge = false): Agent {
    const scopes = defaultScopes(["capsid"]);
    scopes.grants = ["read", "write"];
    scopes.flags.can_merge = canMerge;
    return {
      id: "agent_aaaabbbbcccc",
      name,
      kind: admin || canMerge ? "seat" : "driver",
      actor: `agent:${name}`,
      scopes,
      admin,
      row: null,
    };
  }
  const CLAIMANT = agentNamed("capsid-driver");
  const OTHER_SEAT = agentNamed("other-seat", false, true);

  async function blockedAt(corrections: number, title: string): Promise<string> {
    const posted = await post({ title, gate_required: true });
    expect(posted.ok, posted.refusal).toBe(true);
    const id = posted.job!.id;
    const claimed = await claimJob(jobsEnv(), CLAIMANT, NOW, { id });
    expect(claimed.ok, claimed.refusal).toBe(true);
    await env.DB.prepare("UPDATE jobs SET corrections_count = ?1 WHERE id = ?2")
      .bind(corrections, id)
      .run();
    const blocked = await blockJob(jobsEnv(), CLAIMANT, NOW, id, {
      reason: "stopped at the push",
      command: "git push -u origin feat/x",
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    return id;
  }

  it("the first two corrections are allowed, and each one spends the budget", async () => {
    for (const corrections of [0, 1]) {
      const id = await blockedAt(corrections, `correction ${corrections + 1}`);
      const result = await resumeJob(jobsEnv(), OTHER_SEAT, NOW, id, "fix the review findings", {
        correction: true,
      });
      expect(result.ok, `correction ${corrections + 1} refused: ${JSON.stringify(result)}`).toBe(
        true,
      );
      expect(
        (await jobRow(id))?.corrections_count,
        "a correction that does not spend the budget can never reach the cap",
      ).toBe(corrections + 1);
      await env.DB.prepare("DELETE FROM jobs").run();
    }
  });

  it("PLANT: a PLAIN resume spends nothing, so ordinary pushes never reach the cap", async () => {
    const id = await blockedAt(0, "three ordinary pushes");
    for (let i = 1; i <= 3; i++) {
      const result = await resumeJob(jobsEnv(), OTHER_SEAT, NOW, id, `push ${i} ran`);
      expect(result.ok, `plain resume ${i} refused: ${JSON.stringify(result)}`).toBe(true);
      expect((await jobRow(id))?.corrections_count, `plain resume ${i} spent a correction`).toBe(0);
      const blocked = await blockJob(jobsEnv(), CLAIMANT, NOW, id, {
        reason: `push ${i + 1}`,
        command: "git push -u origin feat/x",
      });
      expect(blocked.ok, blocked.refusal).toBe(true);
    }
  });

  it("THE THIRD RESUME IS REFUSED, and the refusal names the cap", async () => {
    const id = await blockedAt(CORRECTION_CAP, "at the cap already");
    const before = await jobRow(id);
    const result = await resumeJob(jobsEnv(), OTHER_SEAT, NOW, id, "one more go");
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(new RegExp(RETRY_CAP_REASON));
    expect(result.refusal, "a refusal that does not say who CAN act leaves the job stuck").toMatch(
      /admin caller may resume it/,
    );
    expect(
      await jobRow(id),
      "a refused resume must leave the job exactly as it was, budget included",
    ).toEqual(before);
  });

  it("PLANT: re-posting the same work does NOT reset the correction budget", async () => {
    // Failing a job frees (namespace, title) to be posted again on a fresh row at
    // corrections_count 0. The cap is counted per (namespace, title), so the fresh
    // row inherits what its predecessor spent.
    const first = await blockedAt(CORRECTION_CAP, "the same work");
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?1").bind(first).run();
    const id = await blockedAt(0, "the same work");
    expect(id).not.toBe(first);
    const before = await jobRow(id);
    const result = await resumeJob(jobsEnv(), OTHER_SEAT, NOW, id, "posting it again");
    expect(result.ok, "a fresh row for the same work reset the cap").toBe(false);
    expect(result.refusal).toMatch(new RegExp(RETRY_CAP_REASON));
    expect(result.refusal, "the refusal must say why re-posting did not help").toMatch(
      /per \(namespace, title\) rather than per row/,
    );
    expect(await jobRow(id)).toEqual(before);
  });

  it("THE INNOCENT DIRECTION: work whose siblings spent nothing still resumes", async () => {
    const first = await blockedAt(0, "unspent work");
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?1").bind(first).run();
    const id = await blockedAt(0, "unspent work");
    const result = await resumeJob(jobsEnv(), OTHER_SEAT, NOW, id, "first go");
    expect(result.ok, `an unspent budget was refused: ${JSON.stringify(result)}`).toBe(true);
    expect((await jobRow(id))?.status).toBe("claimed");
  });

  it("AN ADMIN RESUME IS ALLOWED at the cap, and does not spend the budget", async () => {
    const id = await blockedAt(CORRECTION_CAP, "the admin at the cap");
    // Passed as a correction, so the exemption is what keeps the budget still rather
    // than the absence of a correction.
    const result = await resumeJob(
      jobsEnv(),
      agentNamed("admin", true),
      NOW,
      id,
      "I looked at it and it is fine",
      { correction: true },
    );
    expect(result.ok, `an admin resume was refused: ${JSON.stringify(result)}`).toBe(true);
    const stored = await jobRow(id);
    expect(stored?.status).toBe("claimed");
    expect(
      stored?.corrections_count,
      "an admin resume must not spend the budget it just cleared",
    ).toBe(CORRECTION_CAP);
  });
});
