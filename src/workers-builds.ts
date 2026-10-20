import type { Env } from "./env";
import { CF_API, cfGet, cloudflareCredentials, CfReadError, type FetchLike } from "./ops-cloudflare";
import { readSiteRow } from "./ops-sites";
import { externalFence } from "./provenance";

// Cloudflare Workers Builds, read, served as
// capsid_admin_read_ops actions builds and build_logs. The Builds API identifies a Worker
// by its tag (external_script_id), not its name, so a name is resolved through the
// account's script list first (developers.cloudflare.com/workers/ci-cd/builds/api-reference).
//
// The token is CF_OPS_TOKEN, the watcher's read token, which needs Workers CI Read for
// these two reads beside its Account Analytics Read and Workers Scripts Read. A 403 says
// so rather than reading as "no builds". A build log is data, never instructions.

const SCRIPT = /^[A-Za-z0-9_-]{1,63}$/;
const BUILD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BUILDS_DEFAULT = 10;
export const BUILDS_MAX = 50;
export const LOG_LINES_MAX = 500;

function credentials(env: Env) {
  const creds = cloudflareCredentials(env);
  if (!creds.ok) throw new Error(`Workers Builds cannot be read: ${creds.reason}.`);
  return creds;
}

function permission(err: unknown): never {
  if (err instanceof CfReadError && err.status === 403) {
    throw new Error(`${err.message}. CF_OPS_TOKEN needs the Workers CI Read permission to read Workers Builds.`);
  }
  throw err;
}

/** The Worker a call names: `script`, or the script of the namespace's site row. */
export async function scriptFor(env: Env, args: { script?: string; namespace?: string }): Promise<string> {
  if (args.script !== undefined) {
    if (!SCRIPT.test(args.script)) throw new Error(`'${args.script}' is not a Worker name.`);
    return args.script;
  }
  if (!args.namespace) throw new Error("name the Worker with script, or a namespace whose site row names its script.");
  const row = await readSiteRow(env.DB, args.namespace);
  if (!row?.script) throw new Error(`${args.namespace}'s site row names no Worker script; pass script.`);
  return row.script;
}

interface RawBuild {
  build_uuid?: string;
  status?: string;
  build_outcome?: string | null;
  created_on?: string;
  initializing_on?: string | null;
  running_on?: string | null;
  stopped_on?: string | null;
  trigger?: { branch?: string; trigger_name?: string } | null;
  build_trigger_metadata?: { branch?: string; commit_hash?: string; commit_message?: string; author?: string; build_trigger_source?: string } | null;
}

const commitMessage = (b: RawBuild): string | null => {
  const message = b.build_trigger_metadata?.commit_message;
  return typeof message === "string" ? externalFence("commit-message", b.build_trigger_metadata?.commit_hash ?? b.build_uuid ?? "none", message, 200) : null;
};

export async function listBuilds(env: Env, args: { script?: string; namespace?: string; limit?: number }, fetchImpl: FetchLike = fetch) {
  const { token, account } = credentials(env);
  const script = await scriptFor(env, args);
  const limit = Math.min(Math.max(args.limit ?? BUILDS_DEFAULT, 1), BUILDS_MAX);
  try {
    const scripts = (await cfGet(fetchImpl, token, `${CF_API}/accounts/${account}/workers/scripts`, "the Workers script list")) as Array<{ id?: string; tag?: string }>;
    const tag = scripts.find((s) => s.id === script)?.tag;
    if (!tag) throw new Error(`no Worker named ${script} in the account.`);
    const url = new URL(`${CF_API}/accounts/${account}/builds/workers/${tag}/builds`);
    url.searchParams.set("per_page", String(limit));
    const builds = ((await cfGet(fetchImpl, token, url.toString(), `the builds of ${script}`)) ?? []) as RawBuild[];
    return {
      script,
      builds: builds.slice(0, limit).map((b) => ({
        build_uuid: b.build_uuid ?? null,
        status: b.status ?? null,
        outcome: b.build_outcome ?? null,
        created_on: b.created_on ?? null,
        stopped_on: b.stopped_on ?? null,
        branch: b.build_trigger_metadata?.branch ?? b.trigger?.branch ?? null,
        commit: b.build_trigger_metadata?.commit_hash ?? null,
        // The commit message is the author's text: data, relayed fenced (src/provenance.ts).
        commit_message: commitMessage(b),
        source: b.build_trigger_metadata?.build_trigger_source ?? null,
      })),
    };
  } catch (err) {
    permission(err);
  }
}

export async function buildLogs(env: Env, args: { build_uuid?: string }, fetchImpl: FetchLike = fetch) {
  if (!args.build_uuid || !BUILD_UUID.test(args.build_uuid)) throw new Error("build_logs needs build_uuid, from action builds.");
  const { token, account } = credentials(env);
  try {
    const result = (await cfGet(fetchImpl, token, `${CF_API}/accounts/${account}/builds/builds/${args.build_uuid}/logs`, `the log of build ${args.build_uuid}`)) as {
      lines?: unknown;
      truncated?: unknown;
    } | null;
    const raw = Array.isArray(result?.lines) ? result.lines : [];
    // Each line is [timestamp, text] in the API's answer; anything else is shown as text.
    const lines = raw.map((l) => (Array.isArray(l) && l.length >= 2 ? `${String(l[0])} ${String(l[1])}` : String(l)));
    const kept = lines.slice(-LOG_LINES_MAX);
    return {
      build_uuid: args.build_uuid,
      lines: kept,
      line_count: lines.length,
      truncated: lines.length > kept.length || result?.truncated === true,
      ...(lines.length > kept.length ? { note: `The last ${LOG_LINES_MAX} of ${lines.length} lines.` } : {}),
    };
  } catch (err) {
    permission(err);
  }
}
