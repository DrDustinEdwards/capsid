import type { Env } from "./env";
import type { SiteOperator } from "./ops-types";

// A SITE'S OPERATOR API (job_09e5f6cbf782, Dustin 2026-10-03). Capsid is the operations
// hub and may trigger an allowlist of a site's own repair tools, so the repairs, the
// convergence view and the watchdog can leave the site. A site opts in by configuration
// (ops_sites.operator, migrations/0035), never by code here.
//
// Two allowlists, both enforced in this Worker before any request leaves it:
//   - the CEILING, in code: a repair is a sync_* tool (sync_status is a read, not a
//     repair) or refresh_citations. backup_media is never called, and neither is anything
//     else the site's operator API serves (save_post, delete_post, decide_mention...).
//   - the SITE'S OWN list, in its configuration: the tools its repairs map and its weekly
//     tools name. A tool the ceiling allows but the site does not name is refused too.
// Capsid never merges and never mints: the token is one the seat set as a Capsid Worker
// secret, read by name, sent only to the site's own origin, and never logged, returned or
// put in an audit row.

/** The ceiling: the only tools Capsid will ever call as a repair. */
export function repairToolRefusal(tool: string): string | null {
  if (tool === "backup_media") return "backup_media is not a repair Capsid may call: it copies the media bucket, and it stays with the site's own watchdog.";
  if (tool === "sync_status") return "sync_status is a read, not a repair.";
  if (tool === "refresh_citations" || /^sync_[a-z][a-z_]{0,40}$/.test(tool)) return null;
  return `'${tool}' is not a repair Capsid may call: only the site's sync_* tools and refresh_citations are.`;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,48}_OPERATOR_TOKEN$/;
const CHECK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPERATOR_PATH = /^\/[A-Za-z0-9._~/-]{0,199}$/;
const MAX_REPAIRS = 40;
const MAX_SECRETS = 40;
const MAX_JSON = 4000;

export type ParsedOperator = { ok: true; operator: SiteOperator } | { ok: false; refusal: string };

/** A site's operator configuration from its stored or edited JSON, checked whole: one bad
 *  entry refuses all of it, so a configuration is never half applied. */
export function parseOperator(raw: string): ParsedOperator {
  const refuse = (refusal: string): ParsedOperator => ({ ok: false, refusal: `operator: ${refusal}` });
  if (raw.length > MAX_JSON) return refuse(`at most ${MAX_JSON} characters.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return refuse(`not JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("must be a JSON object.");
  const o = value as Record<string, unknown>;
  const known = ["path", "auth_var", "repairs", "weekly", "secrets"];
  const extra = Object.keys(o).filter((k) => !known.includes(k));
  if (extra.length) return refuse(`takes ${known.join(", ")}; '${extra[0]}' is not one of them.`);
  if (typeof o.path !== "string" || !OPERATOR_PATH.test(o.path) || o.path.includes("..")) return refuse("path must be a path on the site's origin, such as /api/operator.");
  if (typeof o.auth_var !== "string" || !SECRET_NAME.test(o.auth_var)) return refuse("auth_var must name a Capsid Worker secret ending in _OPERATOR_TOKEN, such as DUSTINEDWARDS_OPERATOR_TOKEN.");
  const repairs: Array<[string, string]> = [];
  if (o.repairs !== undefined) {
    if (!o.repairs || typeof o.repairs !== "object" || Array.isArray(o.repairs)) return refuse("repairs must map health check names to repair tools.");
    for (const [check, tool] of Object.entries(o.repairs)) {
      if (!CHECK_NAME.test(check)) return refuse(`'${check}' is not a health check name.`);
      if (typeof tool !== "string") return refuse(`the repair for ${check} must be a tool name.`);
      const bad = repairToolRefusal(tool);
      if (bad) return refuse(`${check}: ${bad}`);
      repairs.push([check, tool]);
    }
    if (repairs.length > MAX_REPAIRS) return refuse(`at most ${MAX_REPAIRS} repairs.`);
  }
  const weekly: string[] = [];
  if (o.weekly !== undefined) {
    if (!Array.isArray(o.weekly)) return refuse("weekly must be a list of tools.");
    for (const tool of o.weekly) {
      if (typeof tool !== "string") return refuse("weekly must be a list of tool names.");
      const bad = repairToolRefusal(tool);
      if (bad) return refuse(`weekly: ${bad}`);
      if (!weekly.includes(tool)) weekly.push(tool);
    }
  }
  const secrets: string[] = [];
  if (o.secrets !== undefined) {
    if (!Array.isArray(o.secrets) || o.secrets.length > MAX_SECRETS) return refuse(`secrets must be a list of at most ${MAX_SECRETS} names.`);
    for (const name of o.secrets) {
      if (typeof name !== "string" || !ENV_NAME.test(name)) return refuse(`'${String(name)}' is not a secret name.`);
      if (!secrets.includes(name)) secrets.push(name);
    }
  }
  return { ok: true, operator: { path: o.path, auth_var: o.auth_var, repairs: Object.fromEntries(repairs), weekly, secrets } };
}

/** The tools this site allows: its repairs and its weekly tools. */
export function allowedTools(operator: SiteOperator): string[] {
  return [...new Set([...Object.values(operator.repairs), ...operator.weekly])];
}

/** Why `tool` may not be called on this site, or null. The ceiling first, then the site's
 *  own list, checked again here before every request, not only when the configuration
 *  was saved: a row written before a ceiling change must not outlive it. */
export function toolRefusal(operator: SiteOperator, tool: string, reading = false): string | null {
  if (reading && tool === "sync_status") return null;
  const ceiling = repairToolRefusal(tool);
  if (ceiling) return ceiling;
  if (!allowedTools(operator).includes(tool)) return `${tool} is not in this site's allowlist (${allowedTools(operator).join(", ") || "none"}).`;
  return null;
}

/** Whether the token is set, by name, without reading it out. */
export function tokenSet(env: Env, operator: SiteOperator): boolean {
  const value = (env as unknown as Record<string, unknown>)[operator.auth_var];
  return typeof value === "string" && value.length > 0;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What one call to the operator API came to. `converged` is the tool's own read-back
 *  verdict where it gives one; a 200 without it proves nothing and says so. */
export interface OperatorCall {
  ok: boolean;
  status: number;
  /** The reply's data, for a read (sync_status). Never echoed for a repair. */
  data: unknown;
  converged: boolean | null;
  expected: number | null;
  present: number | null;
  /** What went wrong, in one line, or null. Never carries the token. */
  error: string | null;
}

const CALL_TIMEOUT_MS = 60_000;
const ERROR_MAX = 300;

/** One allowlisted call: POST {tool, args: {}} to the site's operator route with the
 *  configured token. Refused before any request when the tool is not allowed or the token
 *  is not set. Never throws. */
export async function callOperator(
  env: Env,
  site: { origin: string; operator: SiteOperator },
  tool: string,
  fetchImpl: FetchLike = fetch,
  opts: { reading?: boolean } = {}
): Promise<OperatorCall> {
  const fail = (status: number, error: string): OperatorCall => ({ ok: false, status, data: null, converged: null, expected: null, present: null, error: error.slice(0, ERROR_MAX) });
  const refusal = toolRefusal(site.operator, tool, opts.reading === true);
  if (refusal) return fail(0, `refused by Capsid before any request: ${refusal}`);
  const token = (env as unknown as Record<string, unknown>)[site.operator.auth_var];
  if (typeof token !== "string" || token.length === 0) return fail(0, `the Capsid Worker secret ${site.operator.auth_var} is not set, so nothing was called.`);
  let response: Response;
  let payload: unknown;
  try {
    response = await fetchImpl(site.origin + site.operator.path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "capsid" },
      body: JSON.stringify({ tool, args: {} }),
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    payload = await response.json().catch(() => null);
  } catch (err) {
    return fail(0, `${tool} did not complete: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (payload && typeof payload === "object" ? payload : {}) as { ok?: unknown; data?: unknown; error?: unknown };
  if (!response.ok || body.ok !== true) {
    const said = typeof body.error === "string" ? body.error : "no error was given";
    return fail(response.status, `${tool} answered ${response.status}: ${said}`);
  }
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ok: true,
    status: response.status,
    data: opts.reading ? body.data : null,
    converged: typeof data?.converged === "boolean" ? data.converged : null,
    expected: num(data?.expected),
    present: num(data?.present),
    error: null,
  };
}

/** One line for an audit row or a task run: what the call did. */
export function callLine(tool: string, call: OperatorCall): string {
  if (!call.ok) return call.error ?? `${tool} failed`;
  if (call.converged === null) return `${tool} answered ${call.status} without a converged verdict, so nothing was proven`;
  return `${tool} ${call.converged ? "converged" : "did not converge"}${call.expected !== null ? ` (${call.present ?? "?"} of ${call.expected} present)` : ""}`;
}
