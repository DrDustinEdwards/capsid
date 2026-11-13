import { sendEmail } from "@dustinedwards/site-runtime/email";
import type { Env } from "./env";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import type { OpsSiteConfig, SiteOperator } from "./ops-types/sites";
import { runSiteRepair, type RepairOutcome } from "./site-repair";
import { tokenSet, type FetchLike } from "./site-operator";
import { DAY_MS } from "./time";
import { failingCheckNames } from "@dustinedwards/site-runtime/health-read";
import { healthUrl } from "./ops-sites";
import { callSignal } from "./call-signal";

// THE WATCHER'S SITE REPAIRS (job_09e5f6cbf782), the one watcher for every site: dustinedwards.info's own
// watchdog Worker was retired on 2026-11-06 once this covered it. On each watcher pass, for every site with a health route (ops_sites.health_path):
//   1. Read its health route. Healthy (200, ok, and no alert named in `alerts`): nothing to do.
//   2. Unhealthy: the failing checks' names, alert checks included. A site with no operator
//      API is reported as it is. One that opted in (ops_sites.operator) is repaired only when
//      EVERY failing check maps to an allowlisted repair (the site's own rule,
//      app/lib/health/repair.mjs): an unmapped failure may share a cause with the rest, so
//      nothing is repaired and it is reported. An alert (site-runtime's `alert: true`, such as
//      auth-spike) maps to no repair, so it is always reported.
//   3. Each repair through runSiteRepair (src/site-repair.ts): allowlisted, rate-limited,
//      audit-logged and one task_runs row each. Then the health is read again, and when
//      every repair converged, up to three more times thirty seconds apart.
//   4. Still unhealthy, or a repair failed: one finding, site-health-<namespace>, which the
//      Portal shows under Incidents and which clears when a pass finds the site healthy.
//   5. Its weekly tools (refresh_citations) once every WEEK_MS, where it opted in.
// A red-to-green or green-to-red change mails Dustin once, where the seat has bound a
// send_email binding; the finding opens either way.
//
// The watcher still decides nothing a person has not configured: the site names which
// check maps to which tool, the Worker's ceiling bounds what any site may name, and the
// rate limit stops a stuck check from looping.

const HEALTH_TIMEOUT_MS = 10_000;
const WEEK_MS = 7 * DAY_MS;
const WEEKLY_PREFIX = "site-weekly:";
const ALERT_PREFIX = "site-alert:";
const TEXT_MAX = 300;
// The settle after a converged repair: three re-reads thirty seconds apart.
const SETTLE_POLLS = 3;
const SETTLE_MS = 30_000;

export type Sleep = (ms: number) => Promise<unknown>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A finding, in the watcher's terms, without importing the watcher (it imports this). */
interface SiteFinding {
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

export const clip = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

/** A site's health route, read once: its status and JSON body, or why it could not be read.
 *  The watcher and the Portal's convergence view (src/site-convergence.ts) both read it here. */
export async function readHealth(fetchImpl: FetchLike, url: string): Promise<Reading> {
  try {
    const res = await fetchImpl(url, {
      headers: { "user-agent": "capsid-watcher", "cache-control": "no-cache" },
      redirect: "manual",
      signal: callSignal(HEALTH_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json().catch(() => null), error: null };
  } catch (err) {
    return { status: 0, body: null, error: clip(errorMessage(err)) };
  }
}

/** The checks a site-runtime health body names in `alerts` (0.59.0): a failure someone
 *  should hear of now, though the check is only a warning and `ok` stays true. */
function alertChecks(body: unknown): string[] {
  const alerts = (body as { alerts?: unknown } | null)?.alerts;
  return Array.isArray(alerts)
    ? alerts.filter((a): a is string => typeof a === "string" && a !== "").map(clip)
    : [];
}

const healthy = (r: Reading) =>
  r.status === 200 &&
  (r.body as { ok?: unknown } | null)?.ok === true &&
  alertChecks(r.body).length === 0;

/** The failing checks' names, read as the watcher reads every health body
 *  (site-runtime ./health-read), each cut to one line, and every alert the body names. */
export function failingChecks(body: unknown): string[] {
  return [
    ...new Set([
      ...failingCheckNames((body as { checks?: unknown } | null)?.checks).map(clip),
      ...alertChecks(body),
    ]),
  ];
}

/** What to do about a failing health reading: the repairs, in the configuration's order,
 *  or why nothing is repaired. */
export function repairPlan(
  failing: string[],
  operator: SiteOperator,
): { tools: string[] } | { none: string } {
  if (failing.length === 0)
    return {
      none: "the health route reported unhealthy without naming a failing check, so there is nothing to map to a repair",
    };
  const unmapped = failing.filter((n) => !Object.hasOwn(operator.repairs, n));
  if (unmapped.length > 0)
    return {
      none: `${unmapped.join(", ")} ${unmapped.length === 1 ? "maps" : "map"} to no repair, and a failure with an unmapped part may share its cause, so nothing was repaired`,
    };
  const order = Object.keys(operator.repairs);
  return {
    tools: [
      ...new Set(
        order.filter((check) => failing.includes(check)).map((check) => operator.repairs[check]),
      ),
    ],
  };
}

const repairLine = (tool: string, o: RepairOutcome) =>
  o.ran ? o.line : `${tool} was not run: ${o.refusal}`;

/** One site, one pass. */
async function watchSite(
  env: Env,
  site: OpsSiteConfig & { origin: string },
  actor: string,
  fetchImpl: FetchLike,
  now: Date,
  sleep: Sleep,
): Promise<{ finding: SiteFinding | null; read: boolean; lines: string[]; weekly: SiteFinding[] }> {
  const lines: string[] = [];
  const weekly: SiteFinding[] = [];
  const target = site.operator ? { origin: site.origin, operator: site.operator } : null;
  const secretSet = target ? tokenSet(env, target.operator) : false;

  // The weekly tools first and on their own: a weekly run is not a repair and does not
  // wait for drift.
  if (target) {
    for (const tool of target.operator.weekly) {
      const key = `${WEEKLY_PREFIX}${site.namespace}:${tool}`;
      const last = await env.APP_KV.get(key);
      if (last && now.getTime() - Date.parse(last) < WEEK_MS) continue;
      if (!secretSet) {
        weekly.push({
          fingerprint: `site-weekly-${site.namespace}-${tool}`,
          namespace: site.namespace,
          headline: `${site.name}'s weekly ${tool} cannot run`,
          evidence: [
            `the Capsid Worker secret ${target.operator.auth_var} is not set, so nothing was called.`,
          ],
        });
        continue;
      }
      const outcome = await runSiteRepair(
        env,
        { namespace: site.namespace, tool, actor, auto: true, via: "watcher weekly" },
        now,
        fetchImpl,
        target,
      );
      lines.push(`${site.namespace}: ${repairLine(tool, outcome)}`);
      if (outcome.ran && outcome.call.ok)
        await env.APP_KV.put(key, now.toISOString(), { expirationTtl: 30 * 86_400 });
      else if (outcome.ran)
        weekly.push({
          fingerprint: `site-weekly-${site.namespace}-${tool}`,
          namespace: site.namespace,
          headline: `${site.name}'s weekly ${tool} failed`,
          evidence: [outcome.line],
        });
    }
  }

  if (!site.health_path) return { finding: null, read: true, lines, weekly };
  const url = healthUrl(site.origin, site.health_path);
  const reading = await readHealth(fetchImpl, url);
  // A reading that never happened names no drift: the site-down probe covers an
  // unreachable site, and this check does not count as run, so nothing is cleared.
  if (reading.status === 0)
    return {
      finding: null,
      read: false,
      lines: [...lines, `${site.namespace}: health not read (${reading.error})`],
      weekly,
    };
  if (healthy(reading)) return { finding: null, read: true, lines, weekly };

  const failing = failingChecks(reading.body);
  const alerts = alertChecks(reading.body);
  const evidence = [
    `health: ${url} answered ${reading.status}; failing: ${failing.join(", ") || "(none named)"}`,
  ];
  if (alerts.length > 0)
    evidence.push(
      `alert: ${alerts.join(", ")} (site-runtime marks ${alerts.length === 1 ? "this check" : "these checks"} for a person to hear of now)`,
    );
  const plan = target ? repairPlan(failing, target.operator) : null;
  if (!target || !plan) {
    evidence.push(
      "the site has no operator API in Capsid (ops_sites.operator), so nothing was repaired",
    );
  } else if ("none" in plan) {
    evidence.push(plan.none);
  } else if (!secretSet) {
    evidence.push(
      `the mapped repairs (${plan.tools.join(", ")}) were not run: the Capsid Worker secret ${target.operator.auth_var} is not set.`,
    );
  } else {
    let missed = false;
    for (const tool of plan.tools) {
      const outcome = await runSiteRepair(
        env,
        { namespace: site.namespace, tool, actor, auto: true, via: "watcher" },
        now,
        fetchImpl,
        target,
      );
      const line = repairLine(tool, outcome);
      evidence.push(`repair: ${line}`);
      lines.push(`${site.namespace}: ${line}`);
      if (!outcome.ran || !outcome.call.ok || outcome.call.converged === false) missed = true;
    }
    let recheck = await readHealth(fetchImpl, url);
    // Every repair said it converged and the re-read still fails: a store the repair rewrote can list short
    // for about a minute after (dustinedwards.info's Ask index read 157 then 155 after its own sync_ask), so
    // it is re-read a few times before it is a finding and a mail. Waiting spends no CPU, and a cron
    // invocation has fifteen minutes of wall time.
    for (
      let poll = 0;
      !missed && recheck.status !== 0 && !healthy(recheck) && poll < SETTLE_POLLS;
      poll += 1
    ) {
      await sleep(SETTLE_MS);
      recheck = await readHealth(fetchImpl, url);
    }
    if (!missed && healthy(recheck)) return { finding: null, read: true, lines, weekly };
    evidence.push(
      recheck.status === 0
        ? `re-check: not read (${recheck.error}), so the repairs proved nothing`
        : `re-check: answered ${recheck.status}; still failing: ${failingChecks(recheck.body).join(", ") || (healthy(recheck) ? "none" : "(none named)")}`,
    );
  }
  return {
    finding: {
      fingerprint: `site-health-${site.namespace}`,
      namespace: site.namespace,
      headline: headline(site.name, alerts, target !== null),
      evidence,
    },
    read: true,
    lines,
    weekly,
  };
}

/** The finding's headline, which is also the mail's subject: an alert first, by name. */
function headline(name: string, alerts: string[], repairable: boolean): string {
  if (alerts.length > 0) return `${name} raised an alert: ${alerts.join(", ")}`;
  return repairable
    ? `${name} is unhealthy and self-repair did not settle it`
    : `${name} is unhealthy`;
}

/** Every site with a health route or an operator API, one pass, then the red and green mail. */
export async function watchSites(
  env: Env,
  config: readonly OpsSiteConfig[],
  actor: string,
  fetchImpl: FetchLike,
  now: Date,
  sleep: Sleep = realSleep,
): Promise<SiteWatchReport> {
  const findings: SiteFinding[] = [];
  const lines: string[] = [];
  let complete = true;
  for (const site of config) {
    if (!site.origin || (!site.operator && !site.health_path)) continue;
    const r = await watchSite(
      env,
      site as OpsSiteConfig & { origin: string },
      actor,
      fetchImpl,
      now,
      sleep,
    );
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
async function mailOnChange(
  env: Env,
  namespace: string,
  name: string,
  finding: SiteFinding | null,
  now: Date,
): Promise<string[]> {
  const key = `${ALERT_PREFIX}${namespace}`;
  let before: AlertState | null = null;
  try {
    const raw = await env.APP_KV.get(key);
    before = raw ? (JSON.parse(raw) as AlertState) : null;
  } catch (err) {
    logEvent(
      "SITE_ALERT_STATE_UNREADABLE",
      {
        message: `SITE_ALERT_STATE_UNREADABLE ${namespace}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
  const red = finding !== null;
  // No state yet and healthy: nothing changed that anyone needs to hear about.
  if ((before?.red ?? false) === red) return [];
  const subject = finding ? finding.headline : `${name} recovered`;
  const text = red
    ? [
        `Changed to unhealthy at ${now.toISOString()}. You will not be mailed again until it recovers.`,
        "",
        ...(finding?.evidence ?? []),
        "",
        "The finding is open in Capsid Portal, Incidents.",
      ].join("\n")
    : [
        `Healthy again at ${now.toISOString()}${before ? `, after being unhealthy since ${before.since}` : ""}.`,
      ].join("\n");
  const sent = await sendEmail(env.EMAIL, {
    from: env.ALERT_FROM ?? "",
    to: env.ALERT_EMAIL ?? "",
    subject,
    text,
  });
  // A refusal keeps the state, so the next pass sends it again; with nothing configured the change is recorded unmailed.
  if (!sent.sent && sent.code !== "not_configured")
    return [
      `${namespace}: the "${subject}" mail did not send (${clip(sent.error)}); it is retried next pass`,
    ];
  const note = sent.sent
    ? `${namespace}: mailed "${subject}"`
    : `${namespace}: "${subject}" was not mailed: no send_email binding (EMAIL, ALERT_EMAIL, ALERT_FROM) is configured`;
  await env.APP_KV.put(key, JSON.stringify({ red, since: now.toISOString() } satisfies AlertState));
  return [note];
}
