import type { Env } from "./env";
import { logEvent } from "./log";
import type { OpsSiteConfig, SiteOperator } from "./ops-types";
import { runSiteRepair, type RepairOutcome } from "./site-repair";
import { tokenSet, type FetchLike } from "./site-operator";

// THE WATCHER'S SITE REPAIRS (job_09e5f6cbf782), so a site's own watchdog Worker can be
// retired later. On each watcher pass, for every site that opted in (ops_sites.operator):
//   1. Read its health route. Healthy: nothing to do.
//   2. Unhealthy: the failing checks' names. Repair only when EVERY failing check maps to
//      an allowlisted repair (the site's own rule, app/lib/health/repair.mjs): an unmapped
//      failure may share a cause with the rest, so nothing is repaired and it is reported.
//   3. Each repair through runSiteRepair (src/site-repair.ts): allowlisted, rate-limited,
//      audit-logged and one task_runs row each. Then the health is read again.
//   4. Still unhealthy, or a repair failed: one finding, site-health-<namespace>, which the
//      Portal shows under Incidents and which clears when a pass finds the site healthy.
//   5. Its weekly tools (refresh_citations) once every WEEK_MS.
// A red-to-green or green-to-red change mails Dustin once, where the seat has bound a
// send_email binding; the finding opens either way.
//
// The watcher still decides nothing a person has not configured: the site names which
// check maps to which tool, the Worker's ceiling bounds what any site may name, and the
// rate limit stops a stuck check from looping.

const HEALTH_TIMEOUT_MS = 10_000;
export const WEEK_MS = 7 * 86_400_000;
const WEEKLY_PREFIX = "site-weekly:";
const ALERT_PREFIX = "site-alert:";
const TEXT_MAX = 300;

/** A finding, in the watcher's terms, without importing the watcher (it imports this). */
export interface SiteFinding {
  fingerprint: string;
  namespace: string;
  headline: string;
  evidence: string[];
}

export interface SiteWatchReport {
  findings: SiteFinding[];
  // Every opted-in site's health was read, so a site with no finding is known healthy
  // and its open finding may be cleared.
  complete: boolean;
  lines: string[];
}

interface Reading {
  status: number;
  body: unknown;
  error: string | null;
}

const clip = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

async function readHealth(fetchImpl: FetchLike, url: string): Promise<Reading> {
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": "capsid-watcher", "cache-control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return { status: res.status, body: await res.json().catch(() => null), error: null };
  } catch (err) {
    return { status: 0, body: null, error: clip(err instanceof Error ? err.message : String(err)) };
  }
}

const healthy = (r: Reading) => r.status === 200 && (r.body as { ok?: unknown } | null)?.ok === true;

/** The failing checks' names. ok === false, not !ok, so a check missing the field is not
 *  counted as failing (the site's own failingCheckNames). */
export function failingChecks(body: unknown): string[] {
  const checks = (body as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((c) => c && typeof c === "object" && (c as { ok?: unknown }).ok === false && typeof (c as { name?: unknown }).name === "string")
    .map((c) => clip((c as { name: string }).name));
}

/** What to do about a failing health reading: the repairs, in the configuration's order,
 *  or why nothing is repaired. */
export function repairPlan(failing: string[], operator: SiteOperator): { tools: string[] } | { none: string } {
  if (failing.length === 0) return { none: "the health route reported unhealthy without naming a failing check, so there is nothing to map to a repair" };
  const unmapped = failing.filter((n) => !Object.hasOwn(operator.repairs, n));
  if (unmapped.length > 0) return { none: `${unmapped.join(", ")} ${unmapped.length === 1 ? "maps" : "map"} to no repair, and a failure with an unmapped part may share its cause, so nothing was repaired` };
  const order = Object.keys(operator.repairs);
  return { tools: [...new Set(order.filter((check) => failing.includes(check)).map((check) => operator.repairs[check]))] };
}

const repairLine = (tool: string, o: RepairOutcome) => (o.ran ? o.line : `${tool} was not run: ${o.refusal}`);

/** One site, one pass. */
async function watchSite(env: Env, site: OpsSiteConfig & { origin: string; operator: SiteOperator }, actor: string, fetchImpl: FetchLike, now: Date): Promise<{ finding: SiteFinding | null; read: boolean; lines: string[]; weekly: SiteFinding[] }> {
  const lines: string[] = [];
  const weekly: SiteFinding[] = [];
  const operator = site.operator;
  const target = { origin: site.origin, operator };
  const secretSet = tokenSet(env, operator);

  // The weekly tools first and on their own: a weekly run is not a repair and does not
  // wait for drift.
  for (const tool of operator.weekly) {
    const key = `${WEEKLY_PREFIX}${site.namespace}:${tool}`;
    const last = await env.APP_KV.get(key);
    if (last && now.getTime() - Date.parse(last) < WEEK_MS) continue;
    if (!secretSet) {
      weekly.push({ fingerprint: `site-weekly-${site.namespace}-${tool}`, namespace: site.namespace, headline: `${site.name}'s weekly ${tool} cannot run`, evidence: [`the Capsid Worker secret ${operator.auth_var} is not set, so nothing was called.`] });
      continue;
    }
    const outcome = await runSiteRepair(env, { namespace: site.namespace, tool, actor, auto: true, via: "watcher weekly" }, now, fetchImpl, target);
    lines.push(`${site.namespace}: ${repairLine(tool, outcome)}`);
    if (outcome.ran && outcome.call.ok) await env.APP_KV.put(key, now.toISOString(), { expirationTtl: 30 * 86_400 });
    else if (outcome.ran) weekly.push({ fingerprint: `site-weekly-${site.namespace}-${tool}`, namespace: site.namespace, headline: `${site.name}'s weekly ${tool} failed`, evidence: [outcome.line] });
  }

  if (!site.health_path) return { finding: null, read: true, lines, weekly };
  const reading = await readHealth(fetchImpl, site.origin + site.health_path);
  // A reading that never happened names no drift: the site-down probe covers an
  // unreachable site, and this check does not count as run, so nothing is cleared.
  if (reading.status === 0) return { finding: null, read: false, lines: [...lines, `${site.namespace}: health not read (${reading.error})`], weekly };
  if (healthy(reading)) return { finding: null, read: true, lines, weekly };

  const failing = failingChecks(reading.body);
  const evidence = [`health: ${site.origin}${site.health_path} answered ${reading.status}; failing: ${failing.join(", ") || "(none named)"}`];
  const plan = repairPlan(failing, operator);
  if ("none" in plan) {
    evidence.push(plan.none);
  } else if (!secretSet) {
    evidence.push(`the mapped repairs (${plan.tools.join(", ")}) were not run: the Capsid Worker secret ${operator.auth_var} is not set.`);
  } else {
    let missed = false;
    for (const tool of plan.tools) {
      const outcome = await runSiteRepair(env, { namespace: site.namespace, tool, actor, auto: true, via: "watcher" }, now, fetchImpl, target);
      const line = repairLine(tool, outcome);
      evidence.push(`repair: ${line}`);
      lines.push(`${site.namespace}: ${line}`);
      if (!outcome.ran || !outcome.call.ok || outcome.call.converged === false) missed = true;
    }
    const recheck = await readHealth(fetchImpl, site.origin + site.health_path);
    if (!missed && healthy(recheck)) return { finding: null, read: true, lines, weekly };
    evidence.push(
      recheck.status === 0
        ? `re-check: not read (${recheck.error}), so the repairs proved nothing`
        : `re-check: answered ${recheck.status}; still failing: ${failingChecks(recheck.body).join(", ") || (healthy(recheck) ? "none" : "(none named)")}`
    );
  }
  return {
    finding: { fingerprint: `site-health-${site.namespace}`, namespace: site.namespace, headline: `${site.name} is unhealthy and self-repair did not settle it`, evidence },
    read: true,
    lines,
    weekly,
  };
}

/** Every opted-in site, one pass, then the red and green mail. */
export async function watchSites(env: Env, config: readonly OpsSiteConfig[], actor: string, fetchImpl: FetchLike, now: Date): Promise<SiteWatchReport> {
  const findings: SiteFinding[] = [];
  const lines: string[] = [];
  let complete = true;
  for (const site of config) {
    if (!site.origin || !site.operator) continue;
    const r = await watchSite(env, site as OpsSiteConfig & { origin: string; operator: SiteOperator }, actor, fetchImpl, now);
    findings.push(...r.weekly);
    lines.push(...r.lines);
    if (!r.read) {
      complete = false;
      continue;
    }
    if (r.finding) findings.push(r.finding);
    lines.push(...(await mailOnChange(env, site.namespace, site.name, r.finding, now)));
  }
  return { findings, complete, lines };
}

interface AlertState {
  red: boolean;
  since: string;
}

/** Mails once on a change between healthy and not. The state moves only once the mail is
 *  sent, or when there is nothing to send it with, so a failed send retries next pass. */
async function mailOnChange(env: Env, namespace: string, name: string, finding: SiteFinding | null, now: Date): Promise<string[]> {
  const key = `${ALERT_PREFIX}${namespace}`;
  let before: AlertState | null = null;
  try {
    const raw = await env.APP_KV.get(key);
    before = raw ? (JSON.parse(raw) as AlertState) : null;
  } catch (err) {
    logEvent("error", "SITE_ALERT_STATE_UNREADABLE", { message: `SITE_ALERT_STATE_UNREADABLE ${namespace}: ${err instanceof Error ? err.message : String(err)}` });
  }
  const red = finding !== null;
  // No state yet and healthy: nothing changed that anyone needs to hear about.
  if ((before?.red ?? false) === red) return [];
  const subject = red ? `${name} is unhealthy and self-repair did not settle it` : `${name} recovered`;
  const text = red
    ? [`Changed to unhealthy at ${now.toISOString()}. You will not be mailed again until it recovers.`, "", ...(finding?.evidence ?? []), "", "The finding is open in Capsid Portal, Incidents."].join("\n")
    : [`Healthy again at ${now.toISOString()}${before ? `, after being unhealthy since ${before.since}` : ""}.`].join("\n");
  let note: string;
  if (env.EMAIL && env.ALERT_EMAIL && env.ALERT_FROM) {
    try {
      await env.EMAIL.send({ from: env.ALERT_FROM, to: env.ALERT_EMAIL, subject, text });
      note = `${namespace}: mailed "${subject}"`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent("error", "SITE_ALERT_MAIL_FAILED", { message: `SITE_ALERT_MAIL_FAILED ${namespace}: ${message}` });
      // The state stays, so the next pass sends it again.
      return [`${namespace}: the "${subject}" mail did not send (${clip(message)}); it is retried next pass`];
    }
  } else {
    note = `${namespace}: "${subject}" was not mailed: no send_email binding (EMAIL, ALERT_EMAIL, ALERT_FROM) is configured`;
    logEvent("warn", "SITE_ALERT_NOT_MAILED", { message: note });
  }
  await env.APP_KV.put(key, JSON.stringify({ red, since: now.toISOString() } satisfies AlertState));
  return [note];
}
