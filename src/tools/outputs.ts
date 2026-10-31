import { z, type ZodType } from "zod";
import type { Shape } from "./operations";

// What each operation answers on success, as its handler builds it (the `ok(...)` calls in
// this folder and the functions they return). A served tool's outputSchema is its
// operations' shapes merged (src/tools/surface.ts): a key is required only where every
// action always returns it. The SDK checks each successful result against it, so a key a
// handler leaves out on some path is optional here, and every object stays loose: rows
// and GitHub or Cloudflare answers carry fields this file does not name.

const obj = z.looseObject({});
const rows = z.array(obj);
const str = z.string();
const num = z.number();
const bool = z.boolean();
const strs = z.array(z.string());
const nullable = (t: ZodType) => t.nullable();

// A key every variant returns is required; the rest are optional. A key whose type
// differs between variants takes either.
function mergeOutputs(shapes: readonly Shape[]): Shape {
  const types = new Map<string, Map<string, ZodType>>();
  const present = new Map<string, number>();
  for (const shape of shapes) {
    for (const [key, type] of Object.entries(shape)) {
      const inner = type instanceof z.ZodOptional ? (type.unwrap() as ZodType) : type;
      const seen = types.get(key) ?? new Map<string, ZodType>();
      seen.set(JSON.stringify(z.toJSONSchema(inner, { unrepresentable: "any" })), inner);
      types.set(key, seen);
      if (!type.safeParse(undefined).success) present.set(key, (present.get(key) ?? 0) + 1);
    }
  }
  const merged: Shape = {};
  for (const [key, seen] of types) {
    const list = [...seen.values()];
    const type = list.length === 1 ? list[0] : z.union(list as [ZodType, ZodType, ...ZodType[]]);
    merged[key] = present.get(key) === shapes.length ? type : type.optional();
  }
  return merged;
}

// A served tool's outputSchema: its actions' operations, merged.
export function toolOutput(ops: readonly string[]) {
  const shapes = [...new Set(ops)].map((op) => {
    const shape = OUTPUTS[op];
    if (!shape) throw new Error(`no output shape for operation '${op}' (src/tools/outputs.ts)`);
    return shape;
  });
  return z.looseObject(mergeOutputs(shapes));
}

const listed = { documents: rows, count: num, limit: num, truncated: bool, note: str.optional() };

// guardedWrite (./repo-guards) adds audit_warning to any repo write whose audit row failed.
const written = (shape: Shape): Shape => ({ ...shape, audit_warning: str.optional() });
const fileWrite = written({
  repo: str,
  mode: str,
  branch: str,
  path: str,
  commitSha: str,
  allow_workflow_write: bool.optional(),
  fileSha: str.optional(),
  pr: nullable(z.looseObject({ number: num, url: str })).optional(),
  pr_error: str.optional(),
});

const jobResult: Shape = {
  ok: bool,
  action: str,
  job: obj.optional(),
  jobs: rows.optional(),
  truncated: bool.optional(),
  note: str.optional(),
  warnings: strs.optional(),
  outcome: obj.optional(),
  resume_note: obj.optional(),
  resume_notes: rows.optional(),
  resume_notes_dropped: num.optional(),
  overlaps: obj.optional(),
  started: obj.optional(),
  routing: obj.optional(),
  routing_note: str.optional(),
  models: obj.optional(),
  versions: rows.optional(),
  session: obj.optional(),
  routine: obj.optional(),
};

const agentResult: Shape = { ok: bool, action: str, agent: obj.optional(), agents: rows.optional(), key: str.optional(), note: str.optional(), scopes: obj.optional() };

const searchConsole = { namespace: str, origin: str, property: str, report: str };
const bing = { namespace: str, origin: str, site: str, report: str };
const traffic = { namespace: str, origin: str, report: str, since: str };

const OUTPUTS: Record<string, Shape> = {
  // Documents (./docs-read, ./docs-write, ./docs-lifecycle).
  list: listed,
  find: listed,
  search: mergeOutputs([listed, { ...listed, mode: str }, { ...listed, mode: str, fallback: str }]),
  read: {
    id: num,
    namespace: str,
    path: str,
    title: nullable(str),
    type: nullable(str),
    status: str,
    tags: nullable(str),
    created_at: str,
    updated_at: str,
    body: nullable(str),
    last_actor: nullable(str),
  },
  brief: {
    namespace: str,
    conventions: nullable(obj),
    core: nullable(obj),
    open_tasks: rows,
    recent_episodics: rows,
    core_links: z.looseObject({ outgoing: rows, incoming: rows }),
    portfolio_documents: z.looseObject({ namespace: str, read_first: strs, allowlist: strs, note: str }),
    approx_chars: num,
    warning: str.optional(),
    trimmed: strs.optional(),
    floor_exceeds_budget: obj.optional(),
  },
  history: mergeOutputs([
    { id: num, document_id: num, namespace: str, path: str, title: nullable(str), body: nullable(str), snapshot_at: str, bytes: num },
    { namespace: str, path: str, live: nullable(obj), versions: rows, note: str.optional() },
  ]),
  backlinks: { namespace: str, path: str, outgoing: rows, incoming: rows },
  write: mergeOutputs([
    { namespace: str, path: str, action: str, proposal: num, base_sha256: nullable(str), directive_lines: strs, note: str },
    {
      namespace: str,
      path: str,
      action: str,
      mode: str,
      sha256: str,
      bytes: num,
      bytes_before: num.optional(),
      snapshotted: bool,
      concurrency_warning: str.optional(),
      links: num.optional(),
      warning: str.optional(),
    },
  ]),
  restore: { namespace: str, path: str, action: str, version_id: num, snapshot_at: str, sha256: str, bytes: num, snapshotted: bool, note: str.optional() },
  delete: { namespace: str, path: str, action: str, snapshotted: bool, edges_removed: num },
  move: { namespace: str, path: str, new_path: str, action: str, edges_repointed: num },
  // The namespace list is a JSON array, so its structured copy is { text } (./operations).
  namespaces: { text: str },
  register_namespace: { namespace: str, repos: rows, action: str, driver_agent: z.null(), next: str },
  update_namespace: { namespace: str, repos: rows, action: str, previous: str },
  delete_namespace: mergeOutputs([
    {
      namespace: str,
      action: str,
      verdict: str,
      refusals: strs,
      cascade: bool,
      allow_improve_paths: bool,
      counts: obj,
      jobs_by_status: z.record(z.string(), num),
      open_jobs: rows,
      live_agents: strs,
      live_paths: strs,
      max_documents: num,
      policy_paths: strs,
      ops_site: nullable(obj),
      will_delete: strs,
      will_keep: strs,
      token: str.optional(),
      expires_at: str.optional(),
      next: str.optional(),
    },
    { namespace: str, action: str, documents_deleted: num, snapshots: num, edges_removed: num, ops_site_removed: bool, kept: obj },
  ]),
  lint: mergeOutputs([
    {
      mode: str,
      namespace: str,
      core: nullable(obj),
      wiki: rows,
      unconsolidated: rows,
      rules: rows,
      dangling_edges: rows,
      authoritative_counts: nullable(obj),
      count_claims: rows,
      packet_chars: num,
      budget: num,
      truncated: bool,
      trimmed: strs.optional(),
    },
    { mode: str, stored: str, namespace: str, generated: str, documents: obj, checks: rows, integrity: nullable(num), findings: rows },
    { mode: str, namespace: str, consolidated: num, archived: rows },
  ]),

  // Repos (./repo).
  list_repo_tree: { repo: str, path: str, entries: rows },
  read_repo_file: mergeOutputs([
    { repo: str, path: str, size: num, sha: str, content: str },
    { repo: str, requested: num, ok: num, failed: num, bytes: num, files: rows },
  ]),
  search_code: {
    repo: str,
    ref: str,
    query: str,
    candidates: num,
    start: num,
    files_scanned: num,
    total_results: num,
    truncated: bool,
    next_start: num.optional(),
    note: str.optional(),
    unreadable_files: num.optional(),
    unreadable_sample: strs.optional(),
    items: rows,
  },
  write_repo_file: fileWrite,
  delete_repo_file: fileWrite,
  create_branch: written({ repo: str, branch: str, from: str, sha: str }),
  open_pr: written({ repo: str, number: num, url: str, head: str, base: str }),
  manage_pr: written({
    repo: str,
    number: num,
    action: str,
    comment_id: num.optional(),
    url: str.optional(),
    merged: bool.optional(),
    sha: str.optional(),
    message: str.optional(),
    state: str.optional(),
    head_branch: nullable(str).optional(),
    head_branch_deleted: bool.optional(),
    head_branch_note: str.optional(),
    outcome_rows_updated: num.optional(),
  }),
  ci_status: mergeOutputs([
    { repo: str, filter: obj.optional(), runs: rows, failed_run: obj.optional() },
    {
      repo: str,
      filter: obj,
      run: obj,
      jobs: rows.optional(),
      jobs_total: num.optional(),
      jobs_truncated: str.optional(),
      job: obj.optional(),
      step: obj.optional(),
      log_withheld: str.optional(),
      log_unavailable: str.optional(),
      log_region: str.optional(),
      log: str.optional(),
      log_redactions: z.record(z.string(), num).optional(),
    },
  ]),
  repo_refs: { repo: str, default_branch: str, truncated: bool, branches: rows, tags: rows, pull_requests: rows },
  repo_history: mergeOutputs([
    { repo: str, mode: str, commit: obj, files: obj },
    { repo: str, mode: str, base: str.optional(), head: str.optional(), status: str, ahead_by: num, behind_by: num, total_commits: num, commits: rows, files: obj },
    { repo: str, mode: str, ref: str.optional(), limit: num, commits: rows },
  ]),
  delete_branch: mergeOutputs([
    written({ repo: str, branch: str, deleted: bool, forced: bool }),
    written({
      repo: str,
      mode: str,
      branches_read: num,
      lists_complete: bool,
      would_prune: num,
      kept_count: num,
      kept: rows,
      kept_truncated: bool,
      prune: rows,
      deleted: strs,
      skipped: rows,
      remaining: num,
    }),
  ]),
  ci_dispatch: written(
    mergeOutputs([
      { repo: str, mode: str, run_id: num, rerun_requested: bool },
      { repo: str, mode: str, workflow: str, ref: str, dispatched: bool, run_id: nullable(num), polls: num, status: str.optional(), url: str.optional(), note: str.optional() },
    ])
  ),
  tag_release: written({ repo: str, tag: str, sha: str, release: nullable(z.looseObject({ id: num, url: str, notes_chars: num })) }),
  site_check: { namespace: str, origin: str, checked_at: str, health: obj, page: obj, probe: obj },
  search_console: mergeOutputs([
    { ...searchConsole, start_date: str, end_date: str, search_type: str, dimensions: strs, rows, truncated: bool },
    {
      ...searchConsole,
      url: nullable(str),
      verdict: z.unknown(),
      coverage: z.unknown(),
      indexing_state: z.unknown(),
      robots_txt: z.unknown(),
      page_fetch: z.unknown(),
      last_crawl: z.unknown(),
      crawled_as: z.unknown(),
      google_canonical: z.unknown(),
      user_canonical: z.unknown(),
      sitemaps: z.unknown(),
      referring_urls: z.unknown(),
      rich_results: nullable(str),
      link: nullable(str),
    },
    { ...searchConsole, sitemaps: rows },
  ]),
  bing_webmaster: mergeOutputs([
    { ...bing, rows, total_rows: num, truncated: bool, start_date: str, end_date: str, note: str },
    { ...bing, start_date: str, end_date: str, clicks: num, impressions: num, days: rows },
    { ...bing, url: nullable(str), http_status: z.unknown(), discovered: nullable(str), last_crawled: nullable(str), document_size: z.unknown(), anchor_count: z.unknown(), child_urls: z.unknown() },
    { ...bing, sitemaps: rows },
    { ...bing, issues: rows, total_issues: num, truncated: bool },
  ]),
  site_traffic: mergeOutputs([
    { ...traffic, page_views_measured: num, unit: str, vitals: obj },
    { ...traffic, note: str, crawlers: rows, truncated: bool },
    { ...traffic, note: str, failures: rows, truncated: bool },
    { ...traffic, note: str, paths: rows, total_paths: num, truncated: bool, probes: num },
  ]),
  site_audit: {
    namespace: str,
    origin: str,
    pages_fetched: num,
    sitemap_urls: num,
    pages_audited: num,
    hit_page_limit: bool,
    summary: z.record(z.string(), num),
    errors: num,
    findings: rows,
    truncated: bool,
  },

  // Jobs and status (./jobs, ./status).
  jobs: mergeOutputs([
    jobResult,
    { ok: bool, action: str, stale: rows, truncated: bool.optional(), note: str.optional() },
    {
      generated: str,
      budget_minutes: num,
      policy: str,
      policy_note: nullable(str),
      heavy_planned_minutes: num,
      lanes: rows,
      skipped: rows,
      queued_read: num,
      truncated: bool,
      for_namespace: nullable(str),
    },
    { ok: bool, action: str, models: obj },
    { generated: str, since: str, for_namespace: nullable(str), finished: rows, blocked: rows, pull_requests_ready: rows, pull_requests_merged: num, totals: obj, truncated: strs },
  ]),
  status: { canon_paths: rows, canon_proposals: rows.optional(), policies: obj, overnight: obj, merge_safety: nullable(obj), agents: rows.optional(), namespaces: rows },
  admin_control: mergeOutputs([
    { ok: z.literal(true), action: str, namespace: str, path: str, signature: str, sha256: str, bytes: num, resigned: bool },
    { action: str, mode: str, decision: nullable(obj) },
    { ok: z.literal(true), action: str, state: obj },
    { action: str, key: str, hash: str, entry: str, grant: str, already_listed: bool, next_step: str, command: str, warning: str },
  ]),

  // Capsid Admin (./admin, ./agents, ./claims, ./cloudflare, ./controls, ./ops).
  whats_next: { as_of: str, questions: rows, blocked: rows, stale: rows, pull_requests: obj, checks: obj, not_checked: strs },
  workers_builds: { script: str, builds: rows },
  workers_build_logs: { build_uuid: str, lines: strs, line_count: num, truncated: bool, note: str.optional() },
  set_site_key: { namespace: str, matched: bool, note: str, site: obj, carrel: obj },
  agents: mergeOutputs([agentResult, { ok: bool, action: str, archived: rows }]),
  claims: mergeOutputs([
    { filter: obj, groups: rows, waits: rows, usage: rows, truncated: strs },
    { job: obj, outcome: nullable(obj), claims: rows, evaluations: rows, touches: rows, limit: num, truncated: strs },
    { table: str, after: num, limit: num, rows, next_after: nullable(num), provenance: obj },
  ]),
  cloudflare_config: mergeOutputs([
    { action: str, count: num, apps: rows },
    { action: str, count: num, policies: rows },
    { action: str, zones: rows },
    { action: str, count: num, addresses: rows },
  ]),
  controls: mergeOutputs([
    { controls: rows, next: str },
    { action: str, summary: str, changes: strs, audit: strs, token: str, expires_at: str },
    { action: str, summary: str, warning: nullable(str) },
  ]),
  ops_snapshot: mergeOutputs([
    {
      version: num,
      pass_at: str,
      pass_ms: num,
      cadence_min: num,
      checks: rows,
      health: nullable(obj),
      mirror: nullable(obj),
      ci: rows,
      site_map: nullable(obj),
      sites: rows,
      packages: rows.optional(),
    },
    { pass_at: str, site: obj },
    { pass_at: str, namespace: str, slot: num, from: str, to: str, value: str, mark: nullable(str) },
  ]),
};
