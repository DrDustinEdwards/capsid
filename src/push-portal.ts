import {
  readVapidKey,
  sendPush,
  subscriptionProblem,
  type PushSubscriptionKeys,
} from "@dustinedwards/site-runtime/web-push";
import { jsonResponse as json, textResponse as text } from "@dustinedwards/site-runtime/http";
import { digestState } from "./digest";
import type { Env } from "./env";
import type { PortalPush } from "./ops-types/views";
import { gateActionRequest } from "./portal-actions";
import { behindGate } from "./portal-auth";
import { PORTAL_HOST } from "./portal-host";
import { MAX_DEVICES, PORTAL_URL, type DeviceRow, type PushPayload } from "./push";
import { auditStatement } from "./store-guards";

// The Portal's route: GET lists, POST turns a device on or off or sends a test.

export const PORTAL_PUSH_PATH = "/portal/api/push";

async function listDevices(env: Env, now: Date): Promise<PortalPush> {
  const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
  const rows = await env.DB.prepare(
    `SELECT id, label, created_at, last_sent_at, last_status FROM push_subscriptions WHERE status = 'active' ORDER BY id LIMIT ?1`,
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

// GET /portal/api/push: the VAPID public key and the devices with alerts on. Never an endpoint: it
// is a URL anyone could send to.
export const handlePortalPushGet = behindGate(async (_request, env, now) => {
  return json(await listDevices(env, now));
});

// POST /portal/api/push: { op: "on", subscription, label } | { op: "off", id } | { op: "test" }.
// Behind the actions' checks: the session, same-origin, the body cap and CSRF.
export async function handlePortalPushPost(
  request: Request,
  env: Env,
  now: Date = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const gated = await gateActionRequest(request, env, now);
  if (!gated.ok) return gated.response;
  const actor = `access:${gated.email}`;
  const body = gated.body;
  const at = now.toISOString();

  if (body.op === "on") {
    const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
    if (typeof vapid === "string") return text(vapid, 503);
    const s = body.subscription as
      | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
      | undefined;
    const sub = {
      endpoint: s?.endpoint,
      p256dh: s?.keys?.p256dh,
      auth: s?.keys?.auth,
    } as Partial<PushSubscriptionKeys>;
    const problem = subscriptionProblem(sub);
    if (problem) return text(`not turned on: ${problem}`, 400);
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : null;
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_subscriptions WHERE status = 'active'`,
    ).first<{ n: number }>();
    const existing = await env.DB.prepare(
      `SELECT id FROM push_subscriptions WHERE endpoint = ?1 AND status = 'active'`,
    )
      .bind(sub.endpoint)
      .first<{ id: number }>();
    if (!existing && (count?.n ?? 0) >= MAX_DEVICES)
      return text(
        `not turned on: ${MAX_DEVICES} devices already have alerts on. Turn one off first.`,
        409,
      );
    const host = new URL(sub.endpoint!).hostname;
    if (!existing) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, status, created_by, created_at) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6)`,
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
      env.DB.prepare(
        `UPDATE push_subscriptions SET status = 'off', closed_at = ?2 WHERE id = ?1 AND status = 'active' RETURNING id`,
      ).bind(id, at),
    ]);
    if (!moved?.results?.length)
      return text(`device ${id} has no alerts on: it was turned off already or is gone.`, 409);
    await env.DB.batch([auditStatement(env.DB, actor, "push-device-off", null, null, { id })]);
    return json(await listDevices(env, now));
  }

  if (body.op === "test") {
    const vapid = readVapidKey(env.VAPID_PRIVATE_KEY);
    if (typeof vapid === "string") return text(vapid, 503);
    const rows = await env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE status = 'active' ORDER BY id LIMIT ?1`,
    )
      .bind(MAX_DEVICES)
      .all<DeviceRow>();
    const subject = env.ADMIN_EMAIL ? `mailto:${env.ADMIN_EMAIL}` : `https://${PORTAL_HOST}`;
    const payload: PushPayload = {
      title: "Capsid test alert",
      body: "Phone alerts reach this device.",
      url: PORTAL_URL,
      tag: "test",
    };
    const results = [];
    for (const d of rows.results ?? [])
      results.push({
        id: d.id,
        status: (await sendPush(vapid, subject, d, payload, now, fetcher)).status,
      });
    await env.DB.batch([auditStatement(env.DB, actor, "push-test", null, null, { results })]);
    return json({ ...(await listDevices(env, now)), results });
  }

  return text("op must be on, off or test.", 400);
}
