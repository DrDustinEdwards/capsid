import { sendEmail } from "@dustinedwards/site-runtime/email";
import type { Env } from "./env";
import { PORTAL_HOST } from "./portal-host";
import { auditStatement } from "./store-guards";
import { digestProblem } from "./digest";
import { pulseAlerts, readPulse } from "./site-pulse";
import { readSnapshot } from "./ops-snapshot";
import { readStoredTls, tlsAlerts } from "./tls-expiry";
import { domainAlerts } from "./domain-expiry";
import {
  readVapidKey,
  sendPush,
  type PushSubscriptionKeys,
} from "@dustinedwards/site-runtime/web-push";
import { toSqlTime } from "@dustinedwards/site-runtime/time";
import { DAY_MS, utcDay } from "./time";

const STATE_KEY = "push:state";
const SENT_TTL_MS = 30 * DAY_MS;
// A rollback older than this when first seen is history, not an alert.
const RECENT_MS = DAY_MS;
const MAX_PER_TICK = 3;
export const MAX_DEVICES = 10;
export const PORTAL_URL = `https://${PORTAL_HOST}/`;

// Where a tap lands: the item itself on the Portal, not its home page.
const portalPath = (path: string) => `https://${PORTAL_HOST}${path}`;
// A site's own page (/sites/<namespace>), at a tab when one is named.
const siteUrl = (namespace: string, tab?: "deploys") =>
  portalPath(`/sites/${encodeURIComponent(namespace)}${tab ? `?tab=${tab}` : ""}`);
const SITES_URL = portalPath("/sites");

type UrgentKind = "rollback" | "site" | "tls" | "domain";

interface Urgent {
  key: string;
  kind: UrgentKind;
  namespace: string;
  title: string;
  body: string;
  /** The Portal page that shows this item. */
  url: string;
}

interface PushState {
  sent: Record<string, string>;
}

/** What a device receives, decrypted by the Portal's service worker. No actions: a tap opens the url. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

// A corrupt state reads as empty: an alert may go twice, but alerts never stop.
async function readState(env: Env): Promise<PushState> {
  const parsed = (await env.APP_KV.get(STATE_KEY, "json").catch(
    () => null,
  )) as Partial<PushState> | null;
  return { sent: parsed?.sent ?? {} };
}

// The triggers, from what the watcher already keeps. Reads only.
async function gatherUrgent(env: Env, now: Date): Promise<Urgent[]> {
  const out: Urgent[] = [];
  const t = now.getTime();

  // 1. Rollbacks the watcher recorded.
  const since = toSqlTime(t - RECENT_MS);
  const rolled = await env.DB.prepare(
    `SELECT repo, namespace, run_id, head_sha, outcome FROM deploy_outcomes
     WHERE outcome IN ('rolled_back', 'rollback_failed') AND recorded_at >= ?1 ORDER BY recorded_at LIMIT 20`,
  )
    .bind(since)
    .all<{ repo: string; namespace: string; run_id: number; head_sha: string; outcome: string }>();
  for (const r of rolled.results ?? []) {
    const failed = r.outcome === "rollback_failed";
    out.push({
      key: `rollback:${r.repo}:${r.run_id}`,
      kind: "rollback",
      namespace: r.namespace,
      title: failed ? "Rollback failed" : "Deploy rolled back",
      body: `${r.repo} at ${r.head_sha.slice(0, 7)}: ${failed ? "the live gate failed and the rollback did not take effect" : "the live gate failed and the deploy was rolled back"}.`,
      url: siteUrl(r.namespace, "deploys"),
    });
  }

  // 2. Sites, from the five-minute pulse.
  for (const a of pulseAlerts(await readPulse(env), now))
    out.push({ ...a, kind: "site", url: siteUrl(a.namespace) });

  // The error rate: the watcher's site-errors findings from its last pass. A snapshot
  // that cannot be read alerts nothing; the Portal shows that it could not be read.
  const snapshot = await readSnapshot(env).catch(() => null);
  const day = utcDay(now);
  for (const fingerprint of snapshot?.checks.flatMap((c) => c.findings) ?? []) {
    if (!fingerprint.startsWith("site-errors-")) continue;
    const namespace = fingerprint.slice("site-errors-".length);
    const name = snapshot?.sites.find((s) => s.namespace === namespace)?.name ?? namespace;
    out.push({
      key: `site-errors:${namespace}:${day}`,
      kind: "site",
      namespace,
      title: `${name} is returning errors`,
      body: `Over 1 percent of requests in the last complete hour threw or answered 5xx (watcher pass ${snapshot?.pass_at}).`,
      url: siteUrl(namespace),
    });
  }

  // 3. A TLS certificate 21 or 3 days from expiry, and a domain registration 30 or 7 days out. One
  // that cannot be read alerts nothing.
  for (const a of tlsAlerts(await readStoredTls(env).catch(() => null), now))
    out.push({ ...a, kind: "tls", namespace: "capsid", url: SITES_URL });
  for (const a of domainAlerts(snapshot?.expiry?.domains, now))
    out.push({ ...a, kind: "domain", namespace: "capsid", url: SITES_URL });
  return out;
}

export interface DeviceRow extends PushSubscriptionKeys {
  id: number;
}

export interface PushReport {
  ran: boolean;
  note: string;
  sent: string[];
}

/** What is urgent and not yet sent, the first MAX_PER_TICK of it due now, and the sent record to update. */
async function dueAlerts(env: Env, now: Date) {
  const state = await readState(env);
  const before = JSON.stringify(state);
  const urgent = (await gatherUrgent(env, now)).filter((u) => !state.sent[u.key]);
  return { state, before, urgent, due: urgent.slice(0, MAX_PER_TICK) };
}

/** One pass: what is urgent and not yet sent goes to every active device. */
export async function pushTick(
  env: Env,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<PushReport> {
  const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
  // No key means no device can be on, so the alerts take the email fallback.
  if (typeof vapid === "string") return emailFallback(env, now, vapid);
  const devices = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE status = 'active' ORDER BY id LIMIT ?1`,
  )
    .bind(MAX_DEVICES)
    .all<DeviceRow>();
  const live = devices.results ?? [];
  if (live.length === 0) return emailFallback(env, now, "no device has phone alerts on");

  const { state, before, urgent, due } = await dueAlerts(env, now);
  const subject = env.ADMIN_EMAIL ? `mailto:${env.ADMIN_EMAIL}` : `https://${PORTAL_HOST}`;
  const at = now.toISOString();
  const sent: string[] = [];
  const statements: D1PreparedStatement[] = [];
  const gone = new Set<number>();

  for (const u of due) {
    const payload: PushPayload = { title: u.title, body: u.body, url: u.url, tag: u.key };
    let delivered = 0;
    for (const d of live) {
      if (gone.has(d.id)) continue;
      const res = await sendPush(vapid, subject, d, payload, now, fetcher);
      if (res.gone) {
        gone.add(d.id);
        statements.push(
          env.DB.prepare(
            `UPDATE push_subscriptions SET status = 'gone', closed_at = ?2, last_status = ?3 WHERE id = ?1 AND status = 'active' RETURNING id`,
          ).bind(d.id, at, res.status),
          auditStatement(env.DB, "capsid:push", "push-device-gone", null, null, {
            id: d.id,
            status: res.status,
          }),
        );
        continue;
      }
      statements.push(
        env.DB.prepare(
          `UPDATE push_subscriptions SET last_sent_at = ?2, last_status = ?3 WHERE id = ?1 AND status = 'active'`,
        ).bind(d.id, at, res.status),
      );
      if (res.status >= 200 && res.status < 300) delivered++;
    }
    if (delivered > 0) {
      state.sent[u.key] = at;
      sent.push(u.key);
      statements.push(
        auditStatement(env.DB, "capsid:push", "push-sent", u.namespace, null, {
          kind: u.kind,
          key: u.key,
          devices: delivered,
        }),
      );
    }
  }

  for (const [k, v] of Object.entries(state.sent))
    if (now.getTime() - Date.parse(v) > SENT_TTL_MS) delete state.sent[k];
  if (statements.length) await env.DB.batch(statements);
  if (JSON.stringify(state) !== before) await env.APP_KV.put(STATE_KEY, JSON.stringify(state));

  if (due.length === 0) return { ran: false, note: "nothing urgent", sent };
  const failed = due.length - sent.length;
  const later = urgent.length - due.length;
  return {
    ran: true,
    note: `sent ${sent.length} alert(s): ${sent.join(", ") || "none"}${failed ? `; ${failed} reached no device and will be tried again` : ""}${later ? `; ${later} more next tick` : ""}${gone.size ? `; ${gone.size} device(s) gone` : ""}`,
    sent,
  };
}

// With no device subscribed, the same urgent items go by email the way the digest does, and only
// once Email Routing is on.
async function emailFallback(env: Env, now: Date, why: string): Promise<PushReport> {
  const off = digestProblem(env);
  if (off) return { ran: false, note: `${why}, and the email fallback is off: ${off}`, sent: [] };
  const { state, before, urgent, due } = await dueAlerts(env, now);
  const at = now.toISOString();
  let note = `nothing urgent (${why})`;
  const sent: string[] = [];
  if (due.length > 0) {
    const subject = due.length === 1 ? `Capsid: ${due[0]!.title}` : `Capsid: ${due.length} alerts`;
    const text = [
      `${why}, so these came by email (turn a device on in the Portal's Settings).`,
      "",
      ...due.flatMap((u) => [`${u.title}`, u.body, u.url, ""]),
      ...(urgent.length > due.length
        ? [`${urgent.length - due.length} more on the next tick.`]
        : []),
    ].join("\n");
    const mailed = await sendEmail(env.EMAIL, {
      from: env.ALERT_FROM!,
      to: env.ALERT_EMAIL!,
      subject,
      text,
    });
    if (mailed.sent) {
      for (const u of due) {
        state.sent[u.key] = at;
        sent.push(u.key);
      }
      await env.DB.batch(
        due.map((u) =>
          auditStatement(env.DB, "capsid:push", "push-emailed", u.namespace, null, {
            kind: u.kind,
            key: u.key,
          }),
        ),
      );
      note = `emailed ${sent.length} alert(s) (${why}): ${sent.join(", ")}`;
    } else {
      note = `${why}, and Cloudflare refused the fallback mail: ${mailed.error.slice(0, 200)}; tried again next tick`;
    }
  }
  for (const [k, v] of Object.entries(state.sent))
    if (now.getTime() - Date.parse(v) > SENT_TTL_MS) delete state.sent[k];
  if (JSON.stringify(state) !== before) await env.APP_KV.put(STATE_KEY, JSON.stringify(state));
  return { ran: due.length > 0, note, sent };
}
