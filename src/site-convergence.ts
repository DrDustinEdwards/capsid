import type { Env } from "./env";
import { readSiteConfig } from "./ops-sites";
import type { ConvergenceCheck, ConvergenceSite, OpsSiteConfig, SiteOperator } from "./ops-types";
import { REPAIR_AUDIT_ACTION } from "./site-repair";
import { callOperator, tokenSet, toolRefusal, type FetchLike } from "./site-operator";
import { readStoredSecrets } from "./secret-presence";

// THE CONVERGENCE VIEW (job_09e5f6cbf782): per site that opted in, what its own operator
// API says (sync_status: the repository count against D1, the search index and the Ask
// index, and any named divergence) beside what its health route says per content type,
// each failing check with the repair it maps to and whether Capsid may run it, and the
// site Worker's secrets by name, set or not. The operator API and the health route are read
// live when the Portal asks: a view a pass old shows a repair that already ran as still
// needed. The secret names are the watcher's last read (src/secret-presence.ts), because no
// Portal request calls Cloudflare (test/ops-cloudflare.test.ts).
// Every part fails on its own and says why, so one unreadable part is never shown as zero.

const HEALTH_TIMEOUT_MS = 10_000;
const TEXT_MAX = 300;
const STATUS_FIELDS_MAX = 40;
const RECENT_REPAIRS = 5;

const clip = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

/** A health body's checks, each with the repair it maps to. Only the fields the view shows
 *  are kept, as text or numbers: the body is the site's, read as data. */
export function healthChecks(body: unknown, operator: SiteOperator): ConvergenceCheck[] {
  const checks = (body as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  const out: ConvergenceCheck[] = [];
  for (const c of checks) {
    if (!c || typeof c !== "object" || typeof (c as { name?: unknown }).name !== "string") continue;
    const row = c as Record<string, unknown>;
    const name = clip(row.name as string);
    const tool = Object.hasOwn(operator.repairs, name) ? operator.repairs[name] : null;
    const said = [row.detail, row.message, row.reason].find((v) => typeof v === "string") as string | undefined;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out.push({
      name,
      ok: row.ok === true,
      detail: said ? clip(said) : null,
      expected: num(row.expected),
      present: num(row.present),
      repair: tool,
      repair_refusal: tool ? toolRefusal(operator, tool) : null,
    });
  }
  return out;
}

/** sync_status's scalar fields as label and text, and its divergence list as lines. */
export function statusFields(data: unknown): Array<{ key: string; value: string }> {
  if (!data || typeof data !== "object") return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (out.length >= STATUS_FIELDS_MAX) break;
    if (typeof value === "number" || typeof value === "boolean") out.push({ key, value: String(value) });
    else if (typeof value === "string") out.push({ key, value: clip(value) });
    else if (key === "divergences" && value && typeof value === "object") {
      const d = value as { known?: unknown; list?: unknown; divergences?: unknown };
      const list = Array.isArray(d.list) ? d.list : Array.isArray(d.divergences) ? d.divergences : Array.isArray(value) ? (value as unknown[]) : null;
      if (d.known === false) out.push({ key, value: "not known (the record could not be read)" });
      else if (list) out.push({ key, value: list.length === 0 ? "none" : clip(list.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ")) });
    }
  }
  return out;
}

async function readHealth(fetchImpl: FetchLike, url: string): Promise<{ status: number; body: unknown; error: string | null }> {
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": "capsid", "cache-control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return { status: res.status, body: await res.json().catch(() => null), error: null };
  } catch (err) {
    return { status: 0, body: null, error: clip(err instanceof Error ? err.message : String(err)) };
  }
}

/** One site's view. */
async function readSiteConvergence(env: Env, site: OpsSiteConfig, fetchImpl: FetchLike, now: Date): Promise<ConvergenceSite> {
  const base = { namespace: site.namespace, name: site.name, origin: site.origin ?? "", read_at: now.toISOString() };
  if (!site.origin || !site.operator) {
    return { ...base, operator: null, problem: site.operator_problem ?? "no operator API configured", status: null, health: null, secrets: null, recent: [] };
  }
  const operator = site.operator;
  const secretSet = tokenSet(env, operator);

  const status = secretSet
    ? await callOperator(env, { origin: site.origin, operator }, "sync_status", fetchImpl, { reading: true }).then((c) =>
        c.ok ? { ok: true as const, fields: statusFields(c.data), error: null } : { ok: false as const, fields: [], error: c.error }
      )
    : { ok: false as const, fields: [], error: `the Capsid Worker secret ${operator.auth_var} is not set, so the operator API was not called.` };

  const h = site.health_path ? await readHealth(fetchImpl, site.origin + site.health_path) : null;
  const health = !h
    ? { ok: false, http_status: null, checks: [], error: "the site has no health route configured" }
    : { ok: h.status === 200 && (h.body as { ok?: unknown } | null)?.ok === true, http_status: h.status || null, checks: healthChecks(h.body, operator), error: h.error };

  const stored = await readStoredSecrets(env, site.namespace);
  const secrets: ConvergenceSite["secrets"] =
    operator.secrets.length === 0
      ? { state: "none", script: null, rows: [], reason: "the configuration names no secrets to check" }
      : stored ?? { state: "none", script: null, rows: [], reason: "the watcher has not read this Worker's secret names yet; it does on its next pass" };

  const { results } = await env.DB.prepare(
    "SELECT actor, params, at FROM audit_log WHERE action = ?1 AND namespace = ?2 ORDER BY id DESC LIMIT ?3"
  )
    .bind(REPAIR_AUDIT_ACTION, site.namespace, RECENT_REPAIRS)
    .all<{ actor: string; params: string | null; at: string }>();
  const recent = (results ?? []).map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = r.params ? (JSON.parse(r.params) as Record<string, unknown>) : {};
    } catch {
      p = {};
    }
    return {
      // audit_log.at is SQLite's "YYYY-MM-DD HH:MM:SS" in UTC.
      at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.at) ? `${r.at.replace(" ", "T")}Z` : r.at,
      actor: r.actor,
      tool: typeof p.tool === "string" ? p.tool : "?",
      via: typeof p.via === "string" ? p.via : null,
      converged: typeof p.converged === "boolean" ? p.converged : null,
      error: typeof p.error === "string" ? clip(p.error) : null,
    };
  });

  return {
    ...base,
    operator: { path: operator.path, auth_var: operator.auth_var, secret_set: secretSet, repairs: operator.repairs, weekly: operator.weekly },
    problem: null,
    status,
    health,
    secrets,
    recent,
  };
}

/** Every site that opted in, or has a stored configuration it cannot use. */
export async function readConvergence(env: Env, fetchImpl: FetchLike, now: Date): Promise<ConvergenceSite[]> {
  const config = (await readSiteConfig(env.DB)).filter((c) => c.origin && (c.operator || c.operator_problem));
  const out: ConvergenceSite[] = [];
  for (const site of config) out.push(await readSiteConvergence(env, site, fetchImpl, now));
  return out;
}
