import type { Env } from "./env";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import { RETRY_CAP_REASON } from "./jobs-schema";
import { PORTAL_HOST } from "./portal-host";
import { gateActionRequest } from "./portal-actions";
import { portalGate } from "./portal-auth";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalPush } from "./ops-types";
import { readPaused } from "./merge-safety";
import { auditStatement } from "./store-guards";
import { digestState } from "./digest";
import { readVapidKey, sendPush, subscriptionProblem, type PushSubscriptionKeys } from "./web-push";
import { jsonResponse as json, textResponse as text } from "./http";

// PHONE ALERTS (docs/design/design-merge-pipeline.md section 5, PR 7; Dustin's DECIDE 5
// and 6 of 2026-10-09). Web Push to the devices the administrator turned on in the
// Portal's Settings, for exactly six things:
//   1. a `typed` pull request (a money path) waiting more than 2 hours;
//   2. a rollback (deploy_outcomes: rolled_back or rollback_failed);
//   3. a job at the correction cap (blocked with the retry-cap reason);
//   4. a question over 4 hours old on a job with priority 70 or more;
//   5. auto-merge paused for a namespace by the safety shutoff (src/merge-safety.ts);
//   6. a pull request labelled visual waiting for Dustin to look at it (src/visual-pr.ts),
//      once per head, so a new push asks again (job_0368576da167).
// Everything else waits for the digest.
//
// No alert carries an Approve button. The button was for `approve`-class pull requests,
// and no trigger carries one: a typed PR is approved only by typing its number (design
// section 8), a visual PR is approved after looking at its preview in the Portal, and the
// other four are not pull requests. So there is no
// /ops/approve route: a tap opens the Portal, where every answer is given. An alert names
// the repo, the pull request or job id and the class, never a title.
//
// Each item is sent once: what was sent is kept in KV with the time, for 30 days. A typed
// PR's 2 hours are counted from the first tick that saw it typed, kept there too, since
// the awaiting-seat set is rewritten whole on every tick. At most MAX_PER_TICK items go
// out per tick, so turning a device on does not empty a backlog onto it at once.

const STATE_KEY = "push:state";
const SENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TYPED_WAIT_MS = 2 * 60 * 60 * 1000;
const QUESTION_AGE_MS = 4 * 60 * 60 * 1000;
const QUESTION_PRIORITY = 70;
// A rollback or a cap older than this when first seen is history, not an alert.
const RECENT_MS = 24 * 60 * 60 * 1000;
const MAX_PER_TICK = 3;
const MAX_DEVICES = 10;
const PORTAL_URL = `https://${PORTAL_HOST}/`;

// Where a tap lands: the item itself on the Portal, not its home page (the UX audit's M2).
// A pull request's card on Pull requests carries the anchor the dashboard builds
// (dashboard/src/lib/pr-actions.ts, prAnchor); a job opens in its drawer on Jobs.
const portalPath = (path: string) => `https://${PORTAL_HOST}${path}`;
const prUrl = (repo: string, number: number) => portalPath(`/prs#pr-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${number}`);
const jobUrl = (id: string) => portalPath(`/queue/job/${encodeURIComponent(id)}`);
const DEPLOYS_URL = portalPath("/health?tab=deploys");
const AUTO_MERGE_URL = portalPath("/prs#auto-merge");

export type UrgentKind = "typed-pr" | "rollback" | "correction-cap" | "question" | "automerge-paused" | "visual-pr";

export interface Urgent {
  key: string;
  kind: UrgentKind;
  namespace: string;
  title: string;
  body: string;
  /** The Portal page that shows this item. */
  url: string;
}

interface PushState {
  typed_seen: Record<string, string>;
  sent: Record<string, string>;
}

/** What a device receives, decrypted by the Portal's service worker. No actions: a tap
 *  opens the url. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

async function readState(env: Env): Promise<PushState> {
  const raw = await env.APP_KV.get(STATE_KEY);
  const parsed = raw ? (JSON.parse(raw) as Partial<PushState>) : {};
  return { typed_seen: parsed.typed_seen ?? {}, sent: parsed.sent ?? {} };
}

const hours = (ms: number) => `${Math.floor(ms / 3_600_000)}h`;

/** The six triggers, from what the tick, the watcher and the queue already keep. Reads
 *  only; `typedSeen` is updated in place with the typed PRs seen now. */
async function gatherUrgent(env: Env, now: Date, typedSeen: Record<string, string>): Promise<Urgent[]> {
  const out: Urgent[] = [];
  const t = now.getTime();

  // 1. Typed pull requests, from the awaiting-seat set the auto-merge tick writes.
  const raw = await env.APP_KV.get(AWAITING_SEAT_KEY);
  const awaiting = raw ? (JSON.parse(raw) as AwaitingSeat[]) : [];
  const typedNow = new Set<string>();
  for (const a of Array.isArray(awaiting) ? awaiting : []) {
    if (a.class !== "typed") continue;
    const id = `${a.repo}#${a.number}`;
    typedNow.add(id);
    const since = typedSeen[id] ?? now.toISOString();
    typedSeen[id] = since;
    const waited = t - Date.parse(since);
    if (waited > TYPED_WAIT_MS) {
      out.push({ key: `typed:${id}`, kind: "typed-pr", namespace: a.namespace, title: "Typed approval waiting", body: `${id}, class typed (money path), waiting ${hours(waited)}. Approve it by typing its number.`, url: prUrl(a.repo, a.number) });
    }
  }
  for (const id of Object.keys(typedSeen)) if (!typedNow.has(id)) delete typedSeen[id];

  // 6. Visual pull requests, from the same set, sent at once: a look is quick, and the
  // key carries the head, so each new push asks again.
  for (const a of Array.isArray(awaiting) ? awaiting : []) {
    if (!a.visual) continue;
    const id = `${a.repo}#${a.number}`;
    out.push({
      key: `visual:${id}:${a.head_sha ?? a.at}`,
      kind: "visual-pr",
      namespace: a.namespace,
      title: "Visual change to look at",
      body: `${id} changes what people see. Open it for its preview and screenshots, then approve it there.`,
      url: prUrl(a.repo, a.number),
    });
  }

  // 2. Rollbacks the watcher recorded.
  const since = new Date(t - RECENT_MS).toISOString().replace("T", " ").slice(0, 19);
  const rolled = await env.DB.prepare(
    `SELECT repo, namespace, run_id, head_sha, outcome FROM deploy_outcomes
     WHERE outcome IN ('rolled_back', 'rollback_failed') AND recorded_at >= ?1 ORDER BY recorded_at LIMIT 20`
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
      url: DEPLOYS_URL,
    });
  }

  // 3 and 4. Blocked jobs: at the correction cap, or a question on a priority job.
  const blocked = await env.DB.prepare(
    `SELECT id, namespace, priority, result_summary, updated_at FROM jobs WHERE status = 'blocked' ORDER BY updated_at LIMIT 200`
  ).all<{ id: string; namespace: string; priority: number; result_summary: string | null; updated_at: string }>();
  for (const j of blocked.results ?? []) {
    const summary = j.result_summary ?? "";
    const age = t - Date.parse(j.updated_at);
    if (summary.startsWith(RETRY_CAP_REASON) && age <= RECENT_MS) {
      out.push({ key: `cap:${j.id}:${j.updated_at}`, kind: "correction-cap", namespace: j.namespace, title: "Correction cap reached", body: `${j.namespace} job ${j.id}: the reviewer and the driver did not converge. It needs your call.`, url: jobUrl(j.id) });
    } else if (summary.startsWith("QUESTION:") && j.priority >= QUESTION_PRIORITY && age > QUESTION_AGE_MS) {
      out.push({ key: `question:${j.id}:${j.updated_at}`, kind: "question", namespace: j.namespace, title: "Question waiting", body: `${j.namespace} job ${j.id}, priority ${j.priority}, asked ${hours(age)} ago.`, url: jobUrl(j.id) });
    }
  }

  // 5. Namespaces the safety shutoff paused. An unreadable value alerts nothing: the
  // tick already holds every namespace then (src/auto-merge-tick.ts) and logs it.
  try {
    for (const [namespace, p] of Object.entries(await readPaused(env.APP_KV))) {
      out.push({ key: `paused:${namespace}:${p.since}`, kind: "automerge-paused", namespace, title: "Auto-merge paused", body: `${namespace}: ${p.reason}. Unattended merges stop until you resume it with the automerge_resume control (chat, capsid_admin_run_controls) and a reason.`, url: AUTO_MERGE_URL });
    }
  } catch {
    // See above.
  }
  return out;
}

interface DeviceRow extends PushSubscriptionKeys {
  id: number;
}

export interface PushReport {
  ran: boolean;
  note: string;
  sent: string[];
}

/** One pass: what is urgent and not yet sent goes to every active device. */
export async function pushTick(env: Env, now: Date, fetcher: typeof fetch = fetch): Promise<PushReport> {
  const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
  if (typeof vapid === "string") return { ran: false, note: vapid, sent: [] };
  const devices = await env.DB.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE status = 'active' ORDER BY id LIMIT ?1`)
    .bind(MAX_DEVICES)
    .all<DeviceRow>();
  const live = devices.results ?? [];
  if (live.length === 0) return { ran: false, note: "no device has phone alerts on", sent: [] };

  const state = await readState(env);
  const before = JSON.stringify(state);
  const urgent = (await gatherUrgent(env, now, state.typed_seen)).filter((u) => !state.sent[u.key]);
  const due = urgent.slice(0, MAX_PER_TICK);
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
          env.DB.prepare(`UPDATE push_subscriptions SET status = 'gone', closed_at = ?2, last_status = ?3 WHERE id = ?1 AND status = 'active' RETURNING id`).bind(d.id, at, res.status),
          auditStatement(env.DB, "capsid:push", "push-device-gone", null, null, { id: d.id, status: res.status })
        );
        continue;
      }
      statements.push(env.DB.prepare(`UPDATE push_subscriptions SET last_sent_at = ?2, last_status = ?3 WHERE id = ?1 AND status = 'active'`).bind(d.id, at, res.status));
      if (res.status >= 200 && res.status < 300) delivered++;
    }
    if (delivered > 0) {
      state.sent[u.key] = at;
      sent.push(u.key);
      statements.push(auditStatement(env.DB, "capsid:push", "push-sent", u.namespace, null, { kind: u.kind, key: u.key, devices: delivered }));
    }
  }

  for (const [k, v] of Object.entries(state.sent)) if (now.getTime() - Date.parse(v) > SENT_TTL_MS) delete state.sent[k];
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

// ---------------------------------------------------------------------------
// The Portal's route: GET lists, POST turns a device on or off or sends a test.

export const PORTAL_PUSH_PATH = "/portal/api/push";

async function listDevices(env: Env, now: Date): Promise<PortalPush> {
  const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
  const rows = await env.DB.prepare(
    `SELECT id, label, created_at, last_sent_at, last_status FROM push_subscriptions WHERE status = 'active' ORDER BY id LIMIT ?1`
  )
    .bind(MAX_DEVICES)
    .all<PortalPush["devices"][number]>();
  return {
    generated: now.toISOString(),
    public_key: typeof vapid === "string" ? null : vapid.publicKey,
    problem: typeof vapid === "string" ? vapid : null,
    devices: rows.results ?? [],
    digest: await digestState(env),
  };
}

/** GET /portal/api/push: the VAPID public key and the devices with alerts on. Never an
 *  endpoint: it is a URL anyone could send to. */
export async function handlePortalPushGet(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  return json(await listDevices(env, now));
}

/** POST /portal/api/push: { op: "on", subscription, label } | { op: "off", id } | { op: "test" }.
 *  Behind the actions' checks: the session, same-origin, the body cap and CSRF. */
export async function handlePortalPushPost(request: Request, env: Env, now: Date = new Date(), fetcher: typeof fetch = fetch): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const actor = `access:${gated.email}`;
  const body = gated.body;
  const at = now.toISOString();

  if (body.op === "on") {
    const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
    if (typeof vapid === "string") return text(vapid, 503);
    const s = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const sub = { endpoint: s?.endpoint, p256dh: s?.keys?.p256dh, auth: s?.keys?.auth } as Partial<PushSubscriptionKeys>;
    const problem = subscriptionProblem(sub);
    if (problem) return text(`not turned on: ${problem}`, 400);
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : null;
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE status = 'active'`).first<{ n: number }>();
    const existing = await env.DB.prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?1 AND status = 'active'`).bind(sub.endpoint).first<{ id: number }>();
    if (!existing && (count?.n ?? 0) >= MAX_DEVICES) return text(`not turned on: ${MAX_DEVICES} devices already have alerts on. Turn one off first.`, 409);
    const host = new URL(sub.endpoint!).hostname;
    if (!existing) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, status, created_by, created_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6)`
        ).bind(sub.endpoint, sub.p256dh, sub.auth, label, actor, at),
        auditStatement(env.DB, actor, "push-device-on", null, null, { label, push_service: host }),
      ]);
    }
    return json(await listDevices(env, now));
  }

  if (body.op === "off") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return text("op off needs the device's id.", 400);
    const [moved] = await env.DB.batch([
      env.DB.prepare(`UPDATE push_subscriptions SET status = 'off', closed_at = ?2 WHERE id = ?1 AND status = 'active' RETURNING id`).bind(id, at),
    ]);
    if (!moved?.results?.length) return text(`device ${id} has no alerts on: it was turned off already or is gone.`, 409);
    await env.DB.batch([auditStatement(env.DB, actor, "push-device-off", null, null, { id })]);
    return json(await listDevices(env, now));
  }

  if (body.op === "test") {
    const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
    if (typeof vapid === "string") return text(vapid, 503);
    const rows = await env.DB.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE status = 'active' ORDER BY id LIMIT ?1`).bind(MAX_DEVICES).all<DeviceRow>();
    const subject = env.ADMIN_EMAIL ? `mailto:${env.ADMIN_EMAIL}` : `https://${PORTAL_HOST}`;
    const payload: PushPayload = { title: "Capsid test alert", body: "Phone alerts reach this device.", url: PORTAL_URL, tag: "test" };
    const results = [];
    for (const d of rows.results ?? []) results.push({ id: d.id, status: (await sendPush(vapid, subject, d, payload, now, fetcher)).status });
    await env.DB.batch([auditStatement(env.DB, actor, "push-test", null, null, { results })]);
    return json({ ...(await listDevices(env, now)), results });
  }

  return text("op must be on, off or test.", 400);
}
