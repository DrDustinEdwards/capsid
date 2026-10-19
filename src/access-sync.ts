import type { Agent } from "./agents";
import { resolveAgent } from "./agents";
import type { Env } from "./env";
import { readBoundedText } from "./signed-requests";
import { checkRate, type RateLimitPolicy } from "./rate-limit";
import { checkScope } from "./scope";
import { auditStatement } from "./store-guards";

// THE CLOUDFLARE ACCESS SYNC (job_d0fabaadecb1; design docs/design/design-identity-roles.md,
// "The Cloudflare sync"; Dustin's rulings of 2026-10-09, people and roles, points 1 and 2).
// An app with staff keeps its own members list. When it changes, the app's server posts the
// whole current list here with its own minted agent key, and Capsid, the only holder of the
// write token, makes that app's Access group hold exactly those emails. Apps never hold the
// token (ruling 1).
//
// - The caller names its namespace and must hold the write grant on it through checkScope
//   (CLAUDE.md, one enforcement point rule). The group is never named by the caller: it is
//   the one pinned for that namespace in access_sync_groups (migrations/0040), so a key
//   reaches its own app's group alone.
// - Before writing, the group is read and its name must equal the pinned name, and every
//   include rule must be an email rule. Anything else (a renamed group, a hand-added rule,
//   a pinned id pointing at the wrong group) refuses and writes nothing (ruling 2).
// - The write is a full PUT: name, the members as one email rule each, and the group's
//   exclude and require rules carried over unchanged. The list is the app's whole list, so
//   the group cannot drift from the members page.
// - `removed` names people the app just removed or expired. For each one no longer in the
//   list, the Zero Trust user's seat is freed (access_seat and gateway_seat false). Freeing a
//   seat never grants or blocks anything by itself; the allow list and the app's own check
//   do that, so a seat failure is reported and the sync still counts as written.
// - Every call writes one audit_log row with Cloudflare's answer, refused or not, and the
//   response carries the same, so the app can show "Waiting for Cloudflare" and retry.
// - Admin policies list Dustin's emails directly and never this group, so no sync can add
//   anyone to an admin surface. That is account configuration, not code; docs/portal.md.
//
// The token is CF_ACCESS_SYNC_TOKEN, separate from the read-only CF_OPS_TOKEN, with these
// permissions on this one account and nothing else:
//   Access: Groups Write              GET and PUT /accounts/{id}/access/groups/{group}
//   Access: Users Read                GET /accounts/{id}/access/users (the seat lookup)
//   Zero Trust: Seats Write           PATCH /accounts/{id}/access/seats
// "Access: Groups Write" is narrower than the design's "Organizations, Identity Providers,
// and Groups Write": it reaches rule groups only, not organization settings or identity
// providers (developers.cloudflare.com/fundamentals/api/reference/permissions/, read
// 2026-10-10).

export const ACCESS_SYNC_PATH = "/ops/access-sync";
// Its own base and fetch type rather than src/ops-cloudflare.ts's: that module is the
// read-only watcher path, and test/ops-cloudflare.test.ts keeps its importers to two.
const CF_API = "https://api.cloudflare.com/client/v4";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const ACCESS_SYNC_ACTION = "access-sync";
const MAX_ACCESS_SYNC_BYTES = 65536;
// Cloudflare One's limit on rules in one group.
const MAX_GROUP_MEMBERS = 1000;
const MAX_REMOVED = 100;
const CF_TIMEOUT_MS = 10_000;
const USERS_PER_PAGE = 50;
const USER_PAGES = 20;

export const ACCESS_SYNC_PERMISSION = {
  group: "Access: Groups Write",
  users: "Access: Users Read",
  seats: "Zero Trust: Seats Write",
} as const;

// A busy members page adds a handful of people at once, and each change posts the whole
// list. Fail closed: this path writes to Cloudflare.
const ACCESS_SYNC_LIMIT: RateLimitPolicy = {
  prefix: "access-sync:rate:",
  perHour: 120,
  perDay: 500,
  label: "ACCESS_SYNC",
  onUnavailable: "refuse",
};

export type Checked<T> = { ok: true; value: T } | { ok: false; refusal: string };

export interface SyncRequest {
  namespace: string;
  members: string[];
  removed: string[];
}

export interface PinnedGroup {
  group_id: string;
  group_name: string;
}

export interface SyncResult {
  ok: boolean;
  namespace: string;
  group: string;
  // What Cloudflare holds now (ok) or still held (refused).
  members: number;
  added: string[];
  dropped: string[];
  seats: { freed: string[]; not_found: string[]; kept: string[]; failed: string | null };
  // Why the group was not written, in words, when ok is false.
  refusal: string | null;
  // The HTTP status Cloudflare answered when it refused, or null.
  cloudflare_status: number | null;
  // The group is not the one pinned, or holds a rule the sync would erase: the seat's to
  // fix, not a Cloudflare failure, so a retry cannot help.
  conflict: boolean;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const BODY_KEYS = new Set(["namespace", "members", "removed"]);

/** One email in the form every comparison uses, or null when it is not one. */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/**
 * The request a body describes, or why it is refused. The whole body is refused on the
 * first bad email, so a half-read list is never written as if it were the whole.
 */
export function parseSyncBody(body: unknown): Checked<SyncRequest> {
  const refuse = (refusal: string): Checked<never> => ({ ok: false, refusal });
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("the body must be a JSON object { namespace, members, removed? }");
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!BODY_KEYS.has(key)) return refuse(`unknown field '${key}': a sync has namespace, members and removed only (the group is the one pinned for the namespace, never named here)`);
  if (typeof record.namespace !== "string" || record.namespace === "") return refuse("namespace is required");
  if (!Array.isArray(record.members)) return refuse("members must be an array of emails: the app's whole current list");
  if (record.members.length > MAX_GROUP_MEMBERS) return refuse(`at most ${MAX_GROUP_MEMBERS} members (Cloudflare's rules per group); got ${record.members.length}`);
  const removedRaw = record.removed ?? [];
  if (!Array.isArray(removedRaw)) return refuse("removed must be an array of emails");
  if (removedRaw.length > MAX_REMOVED) return refuse(`at most ${MAX_REMOVED} removed emails per sync; got ${removedRaw.length}`);
  const members = new Set<string>();
  for (const [i, raw] of record.members.entries()) {
    const email = normalizeEmail(raw);
    if (!email) return refuse(`members[${i}] is not an email`);
    members.add(email);
  }
  const removed = new Set<string>();
  for (const [i, raw] of removedRaw.entries()) {
    const email = normalizeEmail(raw);
    if (!email) return refuse(`removed[${i}] is not an email`);
    removed.add(email);
  }
  return { ok: true, value: { namespace: record.namespace, members: [...members].sort(), removed: [...removed].sort() } };
}

/** Why `agent` may not sync `namespace`'s group, or null. */
function syncCallerRefusal(agent: Agent, namespace: string): string | null {
  return checkScope(agent, { tool: ACCESS_SYNC_PATH, grant: "write", namespace });
}

/** The group pinned for a namespace, or null when the seat has pinned none. */
async function readPinnedGroup(db: D1Database, namespace: string): Promise<PinnedGroup | null> {
  const row = await db.prepare("SELECT group_id, group_name FROM access_sync_groups WHERE namespace = ?1").bind(namespace).first<PinnedGroup>();
  return row ?? null;
}

class CfWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CfWriteError";
    this.status = status;
  }
}

type Envelope = { success?: unknown; errors?: unknown; result?: unknown; result_info?: unknown };

function messagesOf(errors: unknown): string {
  if (!Array.isArray(errors)) return "";
  return errors
    .map((e) => (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : ""))
    .filter(Boolean)
    .join("; ")
    .slice(0, 300);
}

// One Cloudflare call. A non-2xx or success false throws with Cloudflare's own words and,
// for a 403, the permission this call needs. The token is never part of a message.
async function cfCall(fetchImpl: FetchLike, token: string, method: "GET" | "PUT" | "PATCH", url: string, what: string, permission: string, body?: unknown): Promise<Envelope> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": "capsid-access-sync" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(CF_TIMEOUT_MS),
  });
  let parsed: Envelope | null = null;
  try {
    parsed = JSON.parse(await res.text()) as Envelope;
  } catch {
    throw new CfWriteError(`${what} answered ${res.status} with a body that is not JSON`, res.status);
  }
  if (!res.ok || parsed?.success !== true) {
    const said = messagesOf(parsed?.errors) || "no error message";
    const lacks = res.status === 403 ? ` CF_ACCESS_SYNC_TOKEN lacks ${permission}.` : "";
    throw new CfWriteError(`${what} answered ${res.status}.${lacks} Cloudflare said: ${said}`, res.status);
  }
  return parsed;
}

type Rule = Record<string, unknown>;

/** The email an include rule names, or null for any other kind of rule. */
function ruleEmail(rule: unknown): string | null {
  if (!rule || typeof rule !== "object") return null;
  const keys = Object.keys(rule);
  if (keys.length !== 1 || keys[0] !== "email") return null;
  return normalizeEmail((rule as { email?: { email?: unknown } }).email?.email);
}

/**
 * Make the pinned group hold exactly `req.members`, then free the seats of `req.removed`
 * that are no longer members. Never throws: every outcome is a SyncResult, so the caller
 * audits it.
 */
export async function runSync(fetchImpl: FetchLike, token: string, account: string, pinned: PinnedGroup, req: SyncRequest): Promise<SyncResult> {
  const base = `${CF_API}/accounts/${encodeURIComponent(account)}/access`;
  const groupUrl = `${base}/groups/${encodeURIComponent(pinned.group_id)}`;
  const result: SyncResult = {
    ok: false,
    namespace: req.namespace,
    group: pinned.group_name,
    members: 0,
    added: [],
    dropped: [],
    seats: { freed: [], not_found: [], kept: [], failed: null },
    refusal: null,
    cloudflare_status: null,
    conflict: false,
  };
  const fail = (refusal: string, status: number | null = null): SyncResult => ({ ...result, refusal, cloudflare_status: status });
  const conflict = (refusal: string): SyncResult => ({ ...result, refusal, conflict: true });

  let current: { name?: unknown; include?: unknown; exclude?: unknown; require?: unknown };
  try {
    current = ((await cfCall(fetchImpl, token, "GET", groupUrl, "the group read", ACCESS_SYNC_PERMISSION.group)).result ?? {}) as typeof current;
  } catch (err) {
    return fail(`the group could not be read, so nothing was written: ${errText(err)}`, err instanceof CfWriteError ? err.status : null);
  }
  if (current.name !== pinned.group_name) {
    return conflict(`the group's name is ${JSON.stringify(current.name)}, not the pinned ${JSON.stringify(pinned.group_name)}, so nothing was written; the seat checks the pin in access_sync_groups`);
  }
  const include = Array.isArray(current.include) ? current.include : [];
  const before = new Set<string>();
  for (const rule of include) {
    const email = ruleEmail(rule);
    if (!email) return conflict("the group holds an include rule that is not a single email, which the sync would erase, so nothing was written; remove it in Cloudflare or pin another group");
    before.add(email);
  }
  result.members = before.size;

  const body = {
    name: pinned.group_name,
    include: req.members.map((email): Rule => ({ email: { email } })),
    exclude: Array.isArray(current.exclude) ? current.exclude : [],
    require: Array.isArray(current.require) ? current.require : [],
  };
  try {
    await cfCall(fetchImpl, token, "PUT", groupUrl, "the group write", ACCESS_SYNC_PERMISSION.group, body);
  } catch (err) {
    return fail(`the group write was refused, so the group still holds its old list: ${errText(err)}`, err instanceof CfWriteError ? err.status : null);
  }
  const after = new Set(req.members);
  result.ok = true;
  result.members = after.size;
  result.added = req.members.filter((e) => !before.has(e));
  result.dropped = [...before].filter((e) => !after.has(e)).sort();

  // Seats: only for people the app says it removed and who are not members now. A person
  // on the list keeps their seat whatever `removed` says.
  const toFree = req.removed.filter((e) => !after.has(e));
  result.seats.kept = req.removed.filter((e) => after.has(e));
  if (toFree.length === 0) return result;
  try {
    const seats = await seatsFor(fetchImpl, token, base, toFree);
    result.seats.not_found = toFree.filter((e) => !seats.has(e));
    const found = toFree.filter((e) => seats.has(e));
    if (found.length) {
      await cfCall(
        fetchImpl,
        token,
        "PATCH",
        `${base}/seats`,
        "the seat release",
        ACCESS_SYNC_PERMISSION.seats,
        found.map((e) => ({ seat_uid: seats.get(e), access_seat: false, gateway_seat: false })),
      );
      result.seats.freed = found;
    }
  } catch (err) {
    result.seats.failed = `the group was written, but the seats were not freed: ${errText(err)}`;
  }
  return result;
}

// The seat of each email, from the Zero Trust users list. The email filter is asked for and
// the answer still matched exactly, because a filter the API ignores must not free the
// wrong seat; the design could not confirm the filter from the docs.
async function seatsFor(fetchImpl: FetchLike, token: string, base: string, emails: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const email of emails) {
    for (let page = 1; ; page++) {
      const u = new URL(`${base}/users`);
      u.searchParams.set("email", email);
      u.searchParams.set("page", String(page));
      u.searchParams.set("per_page", String(USERS_PER_PAGE));
      const env = await cfCall(fetchImpl, token, "GET", u.toString(), "the users read", ACCESS_SYNC_PERMISSION.users);
      const rows = Array.isArray(env.result) ? env.result : [];
      for (const row of rows) {
        const r = row as { email?: unknown; seat_uid?: unknown };
        if (normalizeEmail(r.email) === email && typeof r.seat_uid === "string" && r.seat_uid) out.set(email, r.seat_uid);
      }
      const pages = (env.result_info as { total_pages?: unknown } | undefined)?.total_pages;
      const total = typeof pages === "number" && Number.isFinite(pages) ? pages : 1;
      if (out.has(email) || page >= total) break;
      if (page >= USER_PAGES) throw new Error(`the users list has more than ${USER_PAGES} pages of ${USERS_PER_PAGE} for ${email}`);
    }
  }
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The token and account, or the words for what is missing. */
function syncCredentials(env: Pick<Env, "CF_ACCESS_SYNC_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">): { ok: true; token: string; account: string } | { ok: false; reason: string } {
  const token = env.CF_ACCESS_SYNC_TOKEN?.trim() ?? "";
  const account = env.CF_ACCOUNT_ID?.trim() || env.R2_ACCOUNT_ID?.trim() || "";
  const missing: string[] = [];
  if (!token) missing.push("the Capsid Worker secret CF_ACCESS_SYNC_TOKEN is not set");
  if (!account) missing.push("neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set");
  return missing.length ? { ok: false, reason: `${missing.join("; ")}, so nothing was called` } : { ok: true, token, account };
}

export interface SyncDeps {
  fetch: FetchLike;
  now: Date;
  pinned: (db: D1Database, namespace: string) => Promise<PinnedGroup | null>;
}

const defaultDeps = (): SyncDeps => ({ fetch: (input, init) => fetch(input, init), now: new Date(), pinned: readPinnedGroup });

/**
 * POST /ops/access-sync. The order is the gate's: who, then what, then the rate, then the
 * pin, then Cloudflare, so a refused caller spends nothing and reaches nothing.
 */
export async function handleAccessSync(request: Request, env: Env, deps: SyncDeps = defaultDeps()): Promise<Response> {
  const plain = (message: string, status: number, extra: Record<string, string> = {}) =>
    new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...extra } });
  const caller = await resolveAgent(request, env);
  if (!caller) return plain("unauthorized: the app's own agent key is required", 401, { "WWW-Authenticate": 'Bearer realm="capsid-operator"' });
  const bounded = await readBoundedText(request, MAX_ACCESS_SYNC_BYTES);
  if (!bounded.ok) return plain(`request too large: exceeds ${MAX_ACCESS_SYNC_BYTES} bytes`, 413);
  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    return plain("the body must be JSON", 400);
  }
  const namespace = (body as { namespace?: unknown } | null)?.namespace;
  if (typeof namespace !== "string" || namespace === "") return plain("namespace is required", 400);
  const refusal = syncCallerRefusal(caller.agent, namespace);
  if (refusal) return plain(refusal, 403);
  const parsed = parseSyncBody(body);
  if (!parsed.ok) return plain(parsed.refusal, 400);
  const rate = await checkRate(env.APP_KV, caller.agent.actor, deps.now, ACCESS_SYNC_LIMIT);
  if (!rate.allowed) {
    return rate.window === "unavailable"
      ? plain(`the sync rate limit could not be read, so the sync is refused: ${rate.detail}`, 503, { "Retry-After": "60" })
      : plain(`at most ${rate.limit} syncs per ${rate.window} per key; try again later`, 429, { "Retry-After": rate.window === "hour" ? "3600" : "86400" });
  }
  const pinned = await deps.pinned(env.DB, namespace);
  if (!pinned) return plain(`no Access group is pinned for ${namespace}; the seat adds its row to access_sync_groups`, 409);
  const creds = syncCredentials(env);
  if (!creds.ok) return plain(creds.reason, 503);

  const result = await runSync(deps.fetch, creds.token, creds.account, pinned, parsed.value);
  await auditStatement(env.DB, caller.agent.actor, ACCESS_SYNC_ACTION, namespace, null, {
    group_id: pinned.group_id,
    group_name: pinned.group_name,
    ok: result.ok,
    members: result.members,
    added: result.added,
    dropped: result.dropped,
    seats: result.seats,
    refusal: result.refusal,
    cloudflare_status: result.cloudflare_status,
    conflict: result.conflict,
  }).run();
  // 200 written; 409 the group is not the pinned one or holds a rule the sync would erase
  // (the seat fixes the pin, a retry cannot help); 502 Cloudflare refused or could not be
  // reached (the app shows Waiting for Cloudflare and retries).
  return Response.json(result, { status: result.ok ? 200 : result.conflict ? 409 : 502, headers: { "Cache-Control": "no-store" } });
}
