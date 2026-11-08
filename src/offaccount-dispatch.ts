import type { Env } from "./env";
import { ghFetch } from "./github/client";

// Starts capsid-backups' nightly copy (offaccount.yml) from this Worker's tick instead of
// waiting on GitHub's schedule. GitHub documents that a scheduled workflow can be delayed
// under load, and this one has started 5 to 6 hours late (2026-11-06, 2026-11-07) and not at
// all by 17:00 UTC on 2026-11-08, which left every site's Amazon copy flagged late. A
// workflow_dispatch starts at once. The schedule stays as the second chance: both runs copy
// the same newest dumps, so the later one changes nothing.
//
// Needs the GitHub App's Actions: Write on capsid-backups (docs/bootstrap.md). A refusal is a
// recorded run, not a throw, so the ledger shows a permission that was lowered.

const OWNER = "DrDustinEdwards";
const REPO = "capsid-backups";
const WORKFLOW = "offaccount.yml";
// capsid-backups' own schedule is 11:23 UTC. The sites' last nightly dump is 05:00 UTC.
const DISPATCH_AFTER_UTC_HOUR = 11;
const DISPATCH_AFTER_UTC_MINUTE = 25;

export type DispatchReport = { ran: false } | { ran: true; ok: boolean; note: string };

function dispatchDue(now: Date): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= DISPATCH_AFTER_UTC_HOUR * 60 + DISPATCH_AFTER_UTC_MINUTE;
}

// Runs once per UTC day after 11:25. It first asks GitHub whether the workflow has any run
// created today (schedule, a person's dispatch or an earlier try of this step), so a day the
// schedule was on time, or a person already ran it, is not run twice.
export async function offaccountDispatchTick(env: Env, now: Date): Promise<DispatchReport> {
  if (!dispatchDue(now)) return { ran: false };
  const day = now.toISOString().slice(0, 10);
  const key = "offaccount-dispatch:last";
  if ((await env.APP_KV.get(key)) === day) return { ran: false };
  // A refusal is tried again an hour later, not every five minutes.
  if (await env.APP_KV.get(RETRY_KEY)) return { ran: false };
  const report = await attempt(env, now, day, key);
  if (report.ran && !report.ok) await env.APP_KV.put(RETRY_KEY, "1", { expirationTtl: 3600 });
  return report;
}

const RETRY_KEY = "offaccount-dispatch:retry";

async function attempt(env: Env, now: Date, day: string, key: string): Promise<DispatchReport> {
  const base = `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`;
  const listed = await ghFetch(env, OWNER, REPO, `${base}/runs?created=%3E%3D${day}&per_page=1`);
  if (!listed.ok) {
    return {
      ran: true,
      ok: false,
      note: `could not list ${WORKFLOW} runs: HTTP ${listed.status}`,
    };
  }
  const { total_count: total } = (await listed.json()) as {
    total_count?: number;
  };
  if (typeof total !== "number") {
    return {
      ran: true,
      ok: false,
      note: `${WORKFLOW} runs list had no total_count`,
    };
  }
  if (total > 0) {
    await env.APP_KV.put(key, day, { expirationTtl: 3 * 24 * 3600 });
    return {
      ran: true,
      ok: true,
      note: `${WORKFLOW} already has ${total} run today; left alone`,
    };
  }

  const dispatched = await ghFetch(env, OWNER, REPO, `${base}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "master" }),
  });
  if (dispatched.status !== 204) {
    return {
      ran: true,
      ok: false,
      note: `dispatching ${WORKFLOW} was refused: HTTP ${dispatched.status}`,
    };
  }
  await env.APP_KV.put(key, day, { expirationTtl: 3 * 24 * 3600 });
  return {
    ran: true,
    ok: true,
    note: `started ${WORKFLOW} on master: no run had started by ${now.toISOString().slice(11, 16)} UTC`,
  };
}
