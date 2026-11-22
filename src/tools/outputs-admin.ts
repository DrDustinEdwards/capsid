import type { Shape } from "./operations";
import { bool, mergeOutputs, nullable, num, obj, rows, str, strs } from "./outputs-shapes";

// The output shapes of the Capsid Admin operations (src/tools/outputs.ts merges them into the
// rest).

const agentResult: Shape = {
  ok: bool,
  action: str,
  agent: obj.optional(),
  agents: rows.optional(),
  key: str.optional(),
  note: str.optional(),
  scopes: obj.optional(),
};

export const ADMIN_OUTPUTS: Record<string, Shape> = {
  whats_next: {
    as_of: str,
    questions: rows,
    blocked: rows,
    stale: rows,
    pull_requests: obj,
    checks: obj,
    not_checked: strs,
  },
  workers_builds: { script: str, builds: rows },
  system_versions: { as_of: str, packages: rows, systems: rows, unread: strs },
  system_resources: mergeOutputs([
    {
      version: num,
      read_at: str,
      workers: rows,
      databases: rows,
      kv_namespaces: rows,
      buckets: rows,
      problems: strs,
    },
    {
      read_at: str,
      worker: obj,
      databases: rows,
      kv_namespaces: rows,
      buckets: rows,
      problems: strs,
    },
  ]),
  site_backups: {
    read_at: str,
    capsid: obj,
    sites: rows,
    amazon_report_at: nullable(str),
    not_configured: strs,
  },
  workers_build_logs: {
    build_uuid: str,
    lines: strs,
    line_count: num,
    truncated: bool,
    note: str.optional(),
  },
  agents: mergeOutputs([agentResult, { ok: bool, action: str, archived: rows }]),
  claims: mergeOutputs([
    { filter: obj, groups: rows, waits: rows, usage: rows, truncated: strs },
    {
      job: obj,
      outcome: nullable(obj),
      claims: rows,
      evaluations: rows,
      touches: rows,
      limit: num,
      truncated: strs,
    },
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
    {
      pass_at: str,
      namespace: str,
      slot: num,
      from: str,
      to: str,
      value: str,
      mark: nullable(str),
    },
  ]),
};
