import type { Env } from "./env";
import type { OpsSite } from "./ops-sites";
import type { CfDeploy, HourBucket, SiteCloudflare, WebAnalyticsSite } from "./ops-types";

// The watcher's read of Cloudflare, for the Watch Floor's deploy and error columns
// (capsid/research/design-ops-console.md). It runs inside the watcher pass only, never
// per dashboard request. Two modules import it (test/ops-cloudflare.test.ts):
// src/watcher.ts, and src/ops-cloudflare-config.ts, the admin-only cloudflare_config
// tool's Access and Email Routing reads, which reuse this envelope and paging.
//
// The token, CF_OPS_TOKEN, is read-only and holds these permissions:
//   Workers Scripts Read              GET /accounts/{id}/workers/domains and
//                                     GET /accounts/{id}/workers/scripts/{script}/deployments
//   Account Analytics Read            POST /graphql (workersInvocationsAdaptive)
//   Access: Apps and Policies Read    GET /accounts/{id}/access/apps and /access/policies
//   Email Routing Addresses Read      GET /accounts/{id}/email/routing/addresses
//   Zone Read                         GET /zones
//   Email Routing Rules Read          GET /zones/{zone}/email/routing/rules
//   Account Settings Read             GET /accounts/{id}/rum/site_info/list (the live checks'
//                                     Web Analytics setting; developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/list/)
// The Access, Email Routing and Zone permissions are the cloudflare_config tool's. To add them to the existing token:
// dash.cloudflare.com/profile/api-tokens, the token capsid-portal-read, Edit; add
// Account / Access: Apps and Policies / Read, Account / Email Routing Addresses / Read,
// Zone / Email Routing Rules / Read and Zone / Zone / Read; Zone Resources: All zones
// from the account; Continue to summary, Update token. The secret value does not change.
//
// What this read cannot see: a failed deploy. Cloudflare's deployments list records
// only the deployments that happened, so a deploy that failed before it reached
// Cloudflare leaves nothing here to find. No finding is invented for it; a failed
// deploy workflow is already the watcher's ci-red finding on the default branch.

export const CF_API = "https://api.cloudflare.com/client/v4";
export const CF_GRAPHQL = `${CF_API}/graphql`;
const CF_TIMEOUT_MS = 10_000;
export const DEPLOYS_KEPT = 10;
const ERROR_HOURS = 24;
const HOUR_MS = 3_600_000;

// Script names are inlined into the GraphQL query as a list literal, so only a name
// that cannot break out of a string literal is sent.
const SCRIPT_NAME = /^[A-Za-z0-9_-]{1,63}$/;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CfCredentials = { ok: true; token: string; account: string } | { ok: false; reason: string };

/** The token and the account it reads. The account is CF_ACCOUNT_ID, or R2_ACCOUNT_ID
 *  where that is unset: R2 lives in the same Cloudflare account. The reason names
 *  exactly what is unset. */
export function cloudflareCredentials(env: Pick<Env, "CF_OPS_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">): CfCredentials {
  const token = env.CF_OPS_TOKEN?.trim() ?? "";
  const account = env.CF_ACCOUNT_ID?.trim() || env.R2_ACCOUNT_ID?.trim() || "";
  const missing: string[] = [];
  if (!token) missing.push("CF_OPS_TOKEN is not set");
  if (!account) missing.push("neither CF_ACCOUNT_ID nor R2_ACCOUNT_ID is set");
  if (missing.length) return { ok: false, reason: missing.join("; ") };
  return { ok: true, token, account };
}

const hostOf = (origin: string): string => new URL(origin).hostname.toLowerCase();

/** A failed Cloudflare read, carrying the HTTP status so a caller can say what a 403
 *  means for its endpoint (the permission the token lacks). */
export class CfReadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CfReadError";
    this.status = status;
  }
}

type CfEnvelope = { success?: unknown; errors?: unknown; result?: unknown; result_info?: unknown };

// The Cloudflare REST envelope. `success` false or a non-2xx is a failed read, with
// Cloudflare's own messages as the reason. The token is never part of a reason.
async function cfGet(fetchImpl: FetchLike, token: string, url: string, what: string): Promise<unknown> {
  return (await cfEnvelope(fetchImpl, token, url, what)).result;
}

async function cfEnvelope(fetchImpl: FetchLike, token: string, url: string, what: string): Promise<CfEnvelope> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "capsid-watcher (ops read)" },
    signal: AbortSignal.timeout(CF_TIMEOUT_MS),
  });
  const body = parseJson(await res.text(), `${what} answered ${res.status} with a body that is not JSON`) as CfEnvelope | null;
  if (!res.ok || body?.success !== true) {
    throw new CfReadError(`${what} answered ${res.status}: ${messagesOf(body?.errors) || "no error message"}`, res.status);
  }
  return body;
}

// A list read stops here rather than returning part of a list as if it were the whole.
export const CF_MAX_PAGES = 20;

/** Every item of a paged Cloudflare list, following result_info.total_pages. `url`
 *  carries no page or per_page; both are set here. A list with more than CF_MAX_PAGES
 *  pages fails with the count, never a truncated answer. */
export async function cfGetAll(fetchImpl: FetchLike, token: string, url: string, what: string, perPage: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; ; page++) {
    const u = new URL(url);
    u.searchParams.set("page", String(page));
    u.searchParams.set("per_page", String(perPage));
    const body = await cfEnvelope(fetchImpl, token, u.toString(), what);
    if (!Array.isArray(body.result)) throw new Error(`${what} returned no result array`);
    out.push(...body.result);
    const pages = (body.result_info as { total_pages?: unknown } | null | undefined)?.total_pages;
    // No result_info, or no total_pages, is a list Cloudflare does not page: one page.
    const total = typeof pages === "number" && Number.isFinite(pages) ? pages : 1;
    if (page >= total) return out;
    if (page >= CF_MAX_PAGES) throw new Error(`${what} has ${total} pages of ${perPage}, more than the ${CF_MAX_PAGES} this read follows`);
  }
}

function parseJson(text: string, failure: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(failure);
  }
}

function messagesOf(errors: unknown): string {
  if (!Array.isArray(errors)) return "";
  return errors
    .map((e) => (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : ""))
    .filter(Boolean)
    .join("; ")
    .slice(0, 300);
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** GET /accounts/{id}/workers/domains: every Workers custom domain on the account, as
 *  hostname to the script (`service`) it serves. */
async function readCustomDomains(fetchImpl: FetchLike, token: string, account: string): Promise<Map<string, string>> {
  const result = await cfGet(fetchImpl, token, `${CF_API}/accounts/${encodeURIComponent(account)}/workers/domains`, "the Workers custom domains list");
  if (!Array.isArray(result)) throw new Error("the Workers custom domains list returned no result array");
  const out = new Map<string, string>();
  for (const d of result as Array<{ hostname?: unknown; service?: unknown }>) {
    if (typeof d?.hostname === "string" && typeof d.service === "string" && d.service) out.set(d.hostname.toLowerCase(), d.service);
  }
  return out;
}

export const WEB_ANALYTICS_PERMISSION = "Account / Account Settings / Read";

/** GET /accounts/{id}/rum/site_info/list: every Web Analytics site in the account. A 403
 *  is turned into the permission the token lacks. */
export async function readWebAnalyticsSites(fetchImpl: FetchLike, token: string, account: string): Promise<WebAnalyticsSite[]> {
  const what = "the Web Analytics sites list";
  let rows: unknown[];
  try {
    rows = await cfGetAll(fetchImpl, token, `${CF_API}/accounts/${encodeURIComponent(account)}/rum/site_info/list`, what, 50);
  } catch (err) {
    if (err instanceof CfReadError && err.status === 403) {
      throw new Error(`${what} was refused with 403: CF_OPS_TOKEN lacks ${WEB_ANALYTICS_PERMISSION}. Add it at dash.cloudflare.com/profile/api-tokens, token capsid-portal-read, Edit (docs/portal.md, "The Cloudflare token"). Cloudflare said: ${err.message}`);
    }
    throw err;
  }
  const out: WebAnalyticsSite[] = [];
  for (const row of rows as Array<{ host?: unknown; auto_install?: unknown; ruleset?: { enabled?: unknown } | null }>) {
    if (typeof row?.host !== "string" || row.host === "") continue;
    out.push({
      host: row.host.toLowerCase(),
      auto_install: typeof row.auto_install === "boolean" ? row.auto_install : null,
      enabled: typeof row.ruleset?.enabled === "boolean" ? row.ruleset.enabled : null,
    });
  }
  return out;
}

interface RawDeploy {
  id?: unknown;
  created_on?: unknown;
  versions?: unknown;
  annotations?: unknown;
  author_email?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** One deployment as the dashboard shows it. version_id is the version serving the
 *  largest percentage of traffic. */
function toCfDeploy(raw: RawDeploy): CfDeploy {
  let version_id: string | null = null;
  let best = -1;
  for (const v of Array.isArray(raw.versions) ? (raw.versions as Array<{ percentage?: unknown; version_id?: unknown }>) : []) {
    const pct = typeof v?.percentage === "number" ? v.percentage : -1;
    if (pct > best && typeof v.version_id === "string") {
      best = pct;
      version_id = v.version_id;
    }
  }
  const annotations = raw.annotations && typeof raw.annotations === "object" ? (raw.annotations as Record<string, unknown>) : {};
  return {
    id: str(raw.id) ?? "",
    created_on: str(raw.created_on) ?? "",
    version_id,
    message: str(annotations["workers/message"]),
    triggered_by: str(annotations["workers/triggered_by"]),
    author_email: str(raw.author_email),
  };
}

/** GET /accounts/{id}/workers/scripts/{script}/deployments. Cloudflare lists the
 *  newest first ("the first deployment in the list is the latest deployment actively
 *  serving traffic"); sorted again on created_on so the order does not rest on that. */
async function readDeploys(fetchImpl: FetchLike, token: string, account: string, script: string): Promise<CfDeploy[]> {
  const url = `${CF_API}/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(script)}/deployments`;
  const result = await cfGet(fetchImpl, token, url, `the deployments list for ${script}`);
  const list = (result as { deployments?: unknown } | null)?.deployments;
  if (!Array.isArray(list)) throw new Error(`the deployments list for ${script} returned no deployments array`);
  return (list as RawDeploy[])
    .map(toCfDeploy)
    .sort((a, b) => b.created_on.localeCompare(a.created_on))
    .slice(0, DEPLOYS_KEPT);
}

/** The 24 complete hours before `now`, oldest first. The last is the most recent
 *  complete hour, the one the error-rate finding reads. */
export function errorWindow(now: Date): { start: Date; end: Date; hours: string[] } {
  const end = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const start = new Date(end.getTime() - ERROR_HOURS * HOUR_MS);
  const hours = Array.from({ length: ERROR_HOURS }, (_, i) => new Date(start.getTime() + i * HOUR_MS).toISOString());
  return { start, end, hours };
}

function errorsQuery(scripts: string[]): string {
  for (const s of scripts) if (!SCRIPT_NAME.test(s)) throw new Error(`script name ${JSON.stringify(s)} is not one the query will carry`);
  return `query WatchFloorErrors($accountTag: string, $datetimeStart: string, $datetimeEnd: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { scriptName_in: ${JSON.stringify(scripts)}, datetime_geq: $datetimeStart, datetime_lt: $datetimeEnd }
      ) {
        sum { requests errors }
        dimensions { scriptName datetimeHour }
      }
    }
  }
}`;
}

/** ONE GraphQL Analytics query for every script, hourly, over errorWindow. A script
 *  with no row in an hour had no invocations then, which is a real zero from a query
 *  that succeeded. A query that failed throws, and the caller records no data with the
 *  reason, never zeros. */
async function readErrors(
  fetchImpl: FetchLike,
  token: string,
  account: string,
  scripts: string[],
  now: Date
): Promise<Map<string, HourBucket[]>> {
  const { start, end, hours } = errorWindow(now);
  const res = await fetchImpl(CF_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "capsid-watcher (ops read)" },
    body: JSON.stringify({
      query: errorsQuery(scripts),
      variables: { accountTag: account, datetimeStart: start.toISOString(), datetimeEnd: end.toISOString() },
    }),
    signal: AbortSignal.timeout(CF_TIMEOUT_MS),
  });
  const body = parseJson(await res.text(), `the analytics query answered ${res.status} with a body that is not JSON`) as {
    data?: unknown;
    errors?: unknown;
  } | null;
  const graphErrors = messagesOf(body?.errors);
  if (!res.ok || graphErrors || (Array.isArray(body?.errors) && body.errors.length > 0)) {
    throw new Error(`the analytics query answered ${res.status}: ${graphErrors || "no error message"}`);
  }
  const accounts = (body?.data as { viewer?: { accounts?: unknown } } | null | undefined)?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error("the analytics query returned no account");
  const rows = (accounts[0] as { workersInvocationsAdaptive?: unknown }).workersInvocationsAdaptive;
  if (!Array.isArray(rows)) throw new Error("the analytics query returned no workersInvocationsAdaptive rows");

  const index = new Map(hours.map((h, i) => [h, i]));
  const out = new Map<string, HourBucket[]>(scripts.map((s) => [s, hours.map((hour) => ({ hour, requests: 0, errors: 0 }))]));
  for (const row of rows as Array<{ sum?: { requests?: unknown; errors?: unknown }; dimensions?: { scriptName?: unknown; datetimeHour?: unknown } }>) {
    const script = row?.dimensions?.scriptName;
    const hourRaw = row?.dimensions?.datetimeHour;
    const requests = row?.sum?.requests;
    const errors = row?.sum?.errors;
    if (typeof script !== "string" || typeof hourRaw !== "string" || typeof requests !== "number" || typeof errors !== "number") {
      throw new Error("the analytics query returned a row without scriptName, datetimeHour, requests and errors");
    }
    const at = Date.parse(hourRaw);
    const i = Number.isNaN(at) ? undefined : index.get(new Date(at).toISOString());
    const buckets = out.get(script);
    // A row outside the window or for a script not asked for means the filter is not
    // what this code believes, so the whole read fails rather than being half right.
    if (i === undefined || !buckets) throw new Error(`the analytics query returned a row outside the asked window or scripts (${script} ${hourRaw})`);
    buckets[i].requests += requests;
    buckets[i].errors += errors;
  }
  return out;
}

export interface CloudflareRead {
  // Every site's Cloudflare state, keyed by namespace.
  bySite: Record<string, SiteCloudflare>;
  // True only when the token is set and every read this pass needed succeeded, so a
  // finding the "cloudflare" check owns clears only on a full read.
  ran: boolean;
}

/** Every mapped site's Cloudflare state for this pass. Each failed read is logged and
 *  recorded on the sites it affects with its reason; nothing is reported as zero. */
export async function readCloudflare(
  env: Pick<Env, "CF_OPS_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">,
  sites: readonly OpsSite[],
  fetchImpl: FetchLike,
  now: Date
): Promise<CloudflareRead> {
  const bySite: Record<string, SiteCloudflare> = {};
  const creds = cloudflareCredentials(env);
  const onCloudflare = sites.filter((s) => s.platform === "cloudflare");
  for (const s of sites) {
    if (s.platform !== "cloudflare") bySite[s.namespace] = { state: "not-cloudflare", reason: `${s.name} is served by ${s.platform}, not Cloudflare` };
  }
  if (!creds.ok) {
    for (const s of onCloudflare) bySite[s.namespace] = { state: "no-token", reason: creds.reason };
    return { bySite, ran: false };
  }
  const failed = (what: string, err: unknown): string => {
    const reason = reasonOf(err);
    console.error(`WATCHER_READ_FAILED cloudflare ${what}: ${reason}`);
    return reason;
  };

  let ran = true;

  // Script per site: named in the map where the host proves it (a workers.dev host),
  // otherwise the Workers custom domain for the site's host. Never guessed.
  let domains: Map<string, string> | null = null;
  let domainsReason: string | null = null;
  if (onCloudflare.some((s) => !s.script)) {
    try {
      domains = await readCustomDomains(fetchImpl, creds.token, creds.account);
    } catch (err) {
      domainsReason = failed("custom domains", err);
      ran = false;
    }
  }
  const scriptOf = new Map<string, string>();
  for (const s of onCloudflare) {
    if (s.script) {
      scriptOf.set(s.namespace, s.script);
      continue;
    }
    if (domainsReason !== null) {
      bySite[s.namespace] = { state: "error", reason: `the script could not be resolved: ${domainsReason}` };
      continue;
    }
    const host = hostOf(s.origin);
    const service = domains?.get(host);
    if (service) scriptOf.set(s.namespace, service);
    else bySite[s.namespace] = { state: "unresolved", reason: `no Workers custom domain on the account names ${host}, so its script is not known` };
  }

  const deploys = new Map<string, CfDeploy[]>();
  for (const [namespace, script] of scriptOf) {
    try {
      deploys.set(namespace, await readDeploys(fetchImpl, creds.token, creds.account, script));
    } catch (err) {
      bySite[namespace] = { state: "error", reason: failed(`deployments ${script}`, err) };
      ran = false;
    }
  }

  const scripts = [...new Set([...deploys.keys()].map((ns) => scriptOf.get(ns) as string))].sort();
  let errors: Map<string, HourBucket[]> | null = null;
  let errorsReason: string | null = null;
  if (scripts.length > 0) {
    try {
      errors = await readErrors(fetchImpl, creds.token, creds.account, scripts, now);
    } catch (err) {
      errorsReason = failed("analytics", err);
      ran = false;
    }
  }
  for (const [namespace, list] of deploys) {
    const script = scriptOf.get(namespace) as string;
    const buckets = errors?.get(script) ?? null;
    bySite[namespace] = {
      state: "ok",
      script,
      deploys: list,
      errors24: buckets,
      errors_reason: buckets ? null : (errorsReason ?? "the analytics query returned nothing for this script"),
    };
  }
  return { bySite, ran };
}
