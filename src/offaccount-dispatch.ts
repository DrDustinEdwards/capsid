import { canDispatch } from "@dustinedwards/site-runtime/github";
import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { utcDay } from "./time";

import { errorMessage } from "@dustinedwards/site-runtime/log";

// Starts capsid-backups' nightly copy (offaccount.yml) from this Worker's tick instead of waiting
// on GitHub's schedule. GitHub documents that a scheduled workflow can be delayed under load, and
// this one has started hours late or not at all, which left every site's Amazon copy flagged late.

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
  const day = utcDay(now);
  const probed = await probeOncePerDay(env, day);
  // A failed probe is the report; a passed one is the report only when the copy is not due.
  if (probed && (!probed.ok || !dispatchDue(now))) return probed;
  if (!dispatchDue(now)) return { ran: false };
  const key = "offaccount-dispatch:last";
  if ((await env.APP_KV.get(key)) === day) return { ran: false };
  // A refusal is tried again an hour later, not every five minutes.
  if (await env.APP_KV.get(RETRY_KEY)) return { ran: false };
  const report = await attempt(env, now, day, key).catch((err) => unreachable(err));
  if (report.ran && !report.ok) await env.APP_KV.put(RETRY_KEY, "1", { expirationTtl: 3600 });
  return report;
}

// The copy's start: a workflow_dispatch of offaccount.yml on `ref`, with no inputs.
function postDispatch(env: Env, ref: string): Promise<Response> {
  return ghFetch(
    env,
    OWNER,
    REPO,
    `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    },
  );
}

const RETRY_KEY = "offaccount-dispatch:retry";
const PROBE_KEY = "offaccount-dispatch:probe";
const PROBE_RETRY_KEY = "offaccount-dispatch:probe-retry";

// Once per UTC day, before the copy is due: does the App still hold Actions: Write on
// capsid-backups? site-runtime's canDispatch asks for a branch that does not exist: 422 means yes
// and starts nothing, 403 or 404 means no.
async function probeOncePerDay(
  env: Env,
  day: string,
): Promise<Extract<DispatchReport, { ran: true }> | null> {
  if ((await env.APP_KV.get(PROBE_KEY)) === day) return null;
  if (await env.APP_KV.get(PROBE_RETRY_KEY)) return null;
  let resp: { ok: boolean; status: number };
  try {
    resp = await canDispatch(
      (path, init) => ghFetch(env, OWNER, REPO, path, init),
      OWNER,
      REPO,
      WORKFLOW,
    );
  } catch (err) {
    // No token at all (the App's installation does not cover capsid-backups) throws before any
    // answer. Without this wait it threw on every five-minute tick: 85 failed runs on 2026-11-28.
    await env.APP_KV.put(PROBE_RETRY_KEY, "1", { expirationTtl: 3600 });
    return unreachable(err);
  }
  if (resp.status === 422) {
    await env.APP_KV.put(PROBE_KEY, day, { expirationTtl: 3 * 24 * 3600 });
    return {
      ran: true,
      ok: true,
      note: "the App holds Actions: Write on capsid-backups (probe answered 422)",
    };
  }
  // A start (204) would mean the probe ref exists; either way the permission is not in doubt,
  // but only a 422 or 204 is a pass, so anything else is the refusal the ledger shows.
  if (resp.status === 204) {
    await env.APP_KV.put(PROBE_KEY, day, { expirationTtl: 3 * 24 * 3600 });
    return {
      ran: true,
      ok: true,
      note: "the App holds Actions: Write on capsid-backups (probe started a run)",
    };
  }
  await env.APP_KV.put(PROBE_RETRY_KEY, "1", { expirationTtl: 3600 });
  return {
    ran: true,
    ok: false,
    note: `the App may not dispatch ${WORKFLOW} on capsid-backups: probe answered HTTP ${resp.status}; grant Actions: Write (docs/bootstrap.md)`,
  };
}

// The App could not get a token for capsid-backups. GitHub answers 422 "not accessible to the parent
// installation" when the installation's repository list leaves the repo out.
function unreachable(err: unknown): Extract<DispatchReport, { ran: true }> {
  return {
    ran: true,
    ok: false,
    note: `the App could not reach ${REPO}: ${errorMessage(err)}. Its installation must include ${REPO} (GitHub, Settings, Applications, Configure, Repository access)`,
  };
}

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

  const dispatched = await postDispatch(env, "master");
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
