import {
  BackupIncomplete,
  DEFAULT_RETENTION,
  listAllKeys,
  readDumpJson,
  runCheckedBackup,
  type DumpResult,
} from "@dustinedwards/d1-dump";
import { deleteInChunks, pruneD1, pruneDaily, pruneReports } from "./backup-prune";
import type { Env } from "./env";
import { BACKUP_LAST_OK_KEY } from "./health";
import { probeFts } from "./store-probe";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import type { TaskResult } from "./task-runs";
import { mapLimit } from "./map-limit";

const JSON_PREFIX = "backups/json/";
const MARKDOWN_PREFIX = "backups/markdown/";
const PUT_CONCURRENCY = 20;

// Retention: newest complete run of the last 14 days, 4 ISO weeks, 3 months. `daily` stays 14:
// the 13-day bucket lock (docs/backups.md) refuses deleting younger runs, so fewer only means refusals.
export const DUMP_RETENTION = { daily: DEFAULT_RETENTION.daily, weekly: 4, monthly: 3 };

// Two runs can both read the key empty, so a run re-reads the lease after its export and refuses
// destructive steps unless it is still its own. Per-run token; runs are cron-only (src/site-jobs.ts), so the TTL just exceeds the 15-minute wall.
const LEASE_KEY = "backup:lease";
const LEASE_TTL_SECONDS = 16 * 60;

export async function backupLeaseHeld(env: Env): Promise<boolean> {
  return (await env.APP_KV.get(LEASE_KEY)) !== null;
}

// Tables page rather than load whole: holding every table in one batch killed the cron once version
// bodies grew. Only append-only AUTOINCREMENT tables qualify: rows at or below the MAX(id) bound cannot change.
const PAGED = {
  document_versions: { idColumn: "id", pageRows: 100 },
  audit_log: { idColumn: "id", pageRows: 1000 },
  job_claims: { idColumn: "id", pageRows: 200 },
};
// wrangler's migration ledger; a restore builds the schema from migrations/. push_subscriptions (0041) is
// left out: rows are push credentials and a dump leaves the account. A restore leaves it empty.
export const EXCLUDED = ["d1_migrations", "push_subscriptions"] as const;

// These columns match d1-dump's credential pattern by name but hold counts, not tokens.
export const CREDENTIAL_ALLOW: Record<string, string> = {
  "bench_runs.input_tokens": "a model token count",
  "bench_runs.output_tokens": "a model token count",
  "bench_runs.cache_read_tokens": "a model token count",
  "bench_runs.cache_creation_tokens": "a model token count",
};

// Every real table; test/backup.test.ts derives this list from migrations/. Excluded: documents_fts and
// its shadow tables (rebuilt by triggers) and sqlite_sequence.
export const TABLES = [
  "documents",
  "namespaces",
  "document_versions",
  "audit_log",
  "document_links",
  // Never pruned (except task_runs), so a dump is the only copy outside D1. Outcome counts are verified
  // against PRs GitHub can delete; revoked agents keep their row so audit entries still resolve.
  "jobs",
  "job_outcomes",
  "agents",
  "job_outcome_prs",
  "ops_sites",
  // Hand-edited configuration and weekly rows kept nowhere else (migrations/0028).
  "ops_packages",
  "ops_package_weeks",
  "job_claims",
  "job_evaluations",
  "job_touches",
  "watcher_findings",
  "task_runs",
  "job_versions",
  // Seeded by its migration, so a restore empties it before importing (0036).
  "shared_packages",
  "pr_approvals",
  "deploy_outcomes",
  // Insert-only and close-once by trigger (0047).
  "bench_tasks",
  "bench_runs",
  // Insert-only by trigger (0049).
  "bench_registration",
  "bench_draw",
  // Pruned below: a jti matters only inside the signature window.
  "improve_jti",
  "page_404_daily",
  "ops_uptime_daily",
  "portal_session_ends",
] as const;

interface BackupSummary {
  ran: true;
  json_prefix: string;
  json_keys: string[];
  documents: number;
  markdown_written: number;
  markdown_pruned: number;
  json_backups_kept: number;
  json_backups_pruned: number;
  json_backups_locked: number;
  reports_pruned: number;
  versions_pruned: number;
  audit_pruned: number;
  deploys_pruned: number;
  // Null on a healthy run; otherwise why NOTHING was deleted. Read it before trusting a zero *_pruned.
  prune_refused: string | null;
  preflight: { documents: number; fts: string };
}

interface BackupSkipped {
  ran: false;
  skipped: string;
}

export type BackupResult = BackupSummary | BackupSkipped;

// R2 sometimes refuses a put (10001) and one refusal threw the whole run away; every put writes a
// string under a fixed key, so retrying is safe.
const PUT_ATTEMPTS = 3;
const PUT_RETRY_MS = 1000;

function retryingPuts(bucket: R2Bucket, waitMs: number): R2Bucket {
  const put = async (...args: Parameters<R2Bucket["put"]>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await bucket.put(...args);
      } catch (err) {
        if (attempt >= PUT_ATTEMPTS) throw err;
        logEvent("BACKUP_PUT_RETRY", {
          message: `BACKUP_PUT_RETRY ${args[0]} attempt ${attempt}: ${errorMessage(err)}`,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs * attempt));
      }
    }
  };
  return new Proxy(bucket, {
    get(target, prop) {
      if (prop === "put") return put;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runBackup(env: Env, putRetryMs = PUT_RETRY_MS): Promise<BackupResult> {
  const held = await env.APP_KV.get(LEASE_KEY);
  if (held !== null) {
    logEvent(
      "BACKUP_LEASE_HELD",
      {
        message: `BACKUP_LEASE_HELD another run holds ${LEASE_KEY} (started ${held}); this run pruned nothing`,
      },
      { level: "error" },
    );
    return { ran: false, skipped: "lease-held" };
  }
  const now = new Date().toISOString();
  const lease = `${now} ${crypto.randomUUID()}`;
  await env.APP_KV.put(LEASE_KEY, lease, { expirationTtl: LEASE_TTL_SECONDS });
  try {
    return await exportAndPrune({ ...env, MEDIA: retryingPuts(env.MEDIA, putRetryMs) }, now, lease);
  } finally {
    // Release only this run's own lease: if the TTL lapsed and another run took it, deleting would let a third start.
    const current = await env.APP_KV.get(LEASE_KEY);
    if (current === lease) await env.APP_KV.delete(LEASE_KEY);
    else
      logEvent(
        "BACKUP_LEASE_LOST",
        {
          message: `BACKUP_LEASE_LOST ${LEASE_KEY} is no longer this run's (now ${current}); left in place`,
        },
        { level: "error" },
      );
  }
}

// Allowlist, never a prefix sweep: APP_KV also holds the GitHub token cache and a dump leaves the
// account. Every key below is a control value; backup:lease is this run's own bookkeeping.
function kvPinKeys(): string[] {
  return [BACKUP_LAST_OK_KEY];
}

// null means unset; an unreadable key is { unreadable } because restoring null would clear a real value.
type KvPin = string | null | { unreadable: string };

async function readKvPins(env: Env): Promise<Record<string, KvPin>> {
  const pins: Record<string, KvPin> = {};
  for (const key of kvPinKeys()) {
    try {
      pins[key] = await env.APP_KV.get(key);
    } catch (err) {
      // The D1 dump must not be lost to a KV hiccup.
      pins[key] = { unreadable: errorMessage(err) };
    }
  }
  return pins;
}

type DocRow = { namespace: string; path: string; body: string | null };

// Read back because the package drops each table once written; an unreadable documents object fails the run.
async function dumpedDocs(env: Env, dump: DumpResult): Promise<DocRow[]> {
  const docsKey = dump.tables.find((t) => t.name === "documents")?.key;
  if (!docsKey)
    throw new Error(
      `BACKUP_DOCUMENTS_UNREADABLE the dump at ${dump.prefix} has no readable documents object`,
    );
  const read = await readDumpJson<{ rows: DocRow[] }>(
    env.MEDIA,
    docsKey,
    () => `BACKUP_DOCUMENTS_UNREADABLE the dump at ${dump.prefix} has no readable documents object`,
  );
  return read.rows;
}

// A difference means the live schema is not the one the restore procedure knows, so the run is refused.
function tablesMismatch(dump: DumpResult): string | null {
  const dumped = new Set(dump.tables.map((t) => t.name));
  const listed = new Set<string>(TABLES);
  const missing = TABLES.filter((t) => !dumped.has(t));
  const extra = [...dumped].filter((t) => !listed.has(t));
  return missing.length || extra.length
    ? `tables-mismatch: missing ${missing.join(",") || "none"}; unlisted ${extra.join(",") || "none"}`
    : null;
}

// Run before anything destructive. A SELECT that succeeds with nothing (empty table, or a binding on a
// different database) would mark every markdown object stale and delete the mirror in one call.
async function preflight(
  env: Env,
  docs: DocRow[],
): Promise<{ fts: string; pruneRefused: string | null }> {
  const fts = await probeFts(env.DB);
  const pruneRefused =
    docs.length === 0 ? "documents-empty" : fts === "ok" ? null : `fts-probe-failed: ${fts}`;
  return { fts, pruneRefused };
}

async function mirrorMarkdown(env: Env, docs: DocRow[]): Promise<number> {
  const currentKeys = new Set<string>();
  await mapLimit(docs, PUT_CONCURRENCY, (doc) => {
    const key = `${MARKDOWN_PREFIX}${doc.namespace}/${doc.path}`;
    currentKeys.add(key);
    return env.MEDIA.put(key, doc.body ?? "", {
      httpMetadata: { contentType: "text/markdown" },
    });
  });

  const existingMarkdown = await listAllKeys(env.MEDIA, MARKDOWN_PREFIX);
  const staleMarkdown = existingMarkdown.filter((key) => !currentKeys.has(key));
  if (staleMarkdown.length > 0) await deleteInChunks(env.MEDIA, staleMarkdown);
  return staleMarkdown.length;
}

// Any failed check refuses everything destructive as a unit: a run that cannot trust its read of
// documents cannot trust content derived from it. The JSON dumps stay as evidence.
async function exportAndPrune(env: Env, now: string, lease: string): Promise<BackupSummary> {
  let docs: DocRow[] = [];
  let fts = "not-run";
  // Capsid's reason, named so a log search finds it; the package's only when Capsid's found none.
  let ownReason: string | null = null;

  let dump: DumpResult;
  let pruned = { kept: 0, pruned: 0, locked: 0 };
  let pruneRefused: string | null = null;
  try {
    const result = await runCheckedBackup(env.DB, env.MEDIA, {
      prefix: JSON_PREFIX,
      now: new Date(now),
      retention: { policy: DUMP_RETENTION },
      compress: true,
      paged: PAGED,
      exclude: [...EXCLUDED],
      sidecars: { kv: { keys: await readKvPins(env) } },
      required: ["documents"],
      credentials: { allow: CREDENTIAL_ALLOW },
      check: async (d) => {
        docs = await dumpedDocs(env, d);
        const checked = await preflight(env, docs);
        fts = checked.fts;
        ownReason = tablesMismatch(d) ?? checked.pruneRefused;
        // The lease is get-then-put, so a concurrent run may hold it now; a run that lost it prunes nothing.
        if (ownReason === null) {
          const holder = await env.APP_KV.get(LEASE_KEY);
          if (holder !== lease) ownReason = `lease-lost: ${LEASE_KEY} is now ${holder}`;
        }
        return ownReason === null ? [] : [ownReason];
      },
    });
    dump = result.dump;
    pruned = result.pruned;
  } catch (err) {
    if (!(err instanceof BackupIncomplete)) throw err;
    dump = err.dump;
    pruneRefused = ownReason ?? err.problems.join("; ");
  }
  const jsonPrefix = dump.prefix;
  const jsonKeys = dump.keys;

  if (pruneRefused !== null) {
    logEvent(
      "BACKUP_PREFLIGHT_REFUSED",
      {
        message:
          `BACKUP_PREFLIGHT_REFUSED reason=${pruneRefused} documents=${docs.length} fts=${fts} ` +
          `dumps_written=${jsonKeys.length} prefix=${jsonPrefix}; nothing was written to or deleted from the mirror`,
      },
      { level: "error" },
    );
    return {
      ran: true,
      json_prefix: jsonPrefix,
      json_keys: jsonKeys,
      documents: docs.length,
      markdown_written: 0,
      markdown_pruned: 0,
      json_backups_kept: 0,
      json_backups_pruned: 0,
      json_backups_locked: 0,
      reports_pruned: 0,
      versions_pruned: 0,
      audit_pruned: 0,
      deploys_pruned: 0,
      prune_refused: pruneRefused,
      preflight: { documents: docs.length, fts },
    };
  }

  const markdownPruned = await mirrorMarkdown(env, docs);
  const reports = await pruneReports(env, now);
  const history = await pruneD1(env);
  await pruneDaily(env, new Date(now));

  await env.APP_KV.put(BACKUP_LAST_OK_KEY, now);

  return {
    ran: true,
    json_prefix: jsonPrefix,
    json_keys: jsonKeys,
    documents: docs.length,
    markdown_written: docs.length,
    markdown_pruned: markdownPruned,
    json_backups_kept: pruned.kept,
    json_backups_pruned: pruned.pruned,
    json_backups_locked: pruned.locked,
    reports_pruned: reports,
    versions_pruned: history.versions,
    audit_pruned: history.audit,
    deploys_pruned: history.deploys,
    prune_refused: null,
    preflight: { documents: docs.length, fts },
  };
}

export function backupTaskResult(result: BackupResult): TaskResult {
  if (!result.ran) {
    logEvent(
      "BACKUP_CRON_SKIPPED",
      { message: `BACKUP_CRON_SKIPPED ${result.skipped}` },
      { level: "error" },
    );
    return { outcome: "skipped", reason: `skipped: ${result.skipped}` };
  }
  if (result.prune_refused !== null) {
    logEvent(
      "BACKUP_CRON_REFUSED_PRUNE",
      { message: `BACKUP_CRON_REFUSED_PRUNE ${result.prune_refused}` },
      { level: "error" },
    );
    return {
      outcome: "refused",
      reason: `wrote ${result.json_keys.length} dump objects, and the prune refused: ${result.prune_refused}`,
    };
  }
  return {
    outcome: "ok",
    reason: `wrote ${result.json_keys.length} dump objects (${result.documents} documents); pruned ${result.json_backups_pruned} dumps (${result.json_backups_locked} locked), ${result.versions_pruned} versions, ${result.audit_pruned} audit rows, ${result.deploys_pruned} deploy outcomes`,
  };
}
