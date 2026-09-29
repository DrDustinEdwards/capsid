// A cache. test/tool-annotations.test.ts derives each flag from the handler and
// fails both directions. readOnlyHint is the negation of the write gate.
// destructiveHint is true iff a write-gated handler can overwrite or remove
// existing state. idempotentHint and openWorldHint are absent: a transitive
// "calls github.ts" scan disagreed with the table twice.

export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

const read = (): ToolHints => ({ readOnlyHint: true, destructiveHint: false });
const additive = (): ToolHints => ({ readOnlyHint: false, destructiveHint: false });
const destructive = (): ToolHints => ({ readOnlyHint: false, destructiveHint: true });

export const TOOL_HINTS: Record<string, ToolHints> = {
  list: read(),
  read: read(),
  brief: read(),
  backlinks: read(),
  find: read(),
  search: read(),
  namespaces: read(),
  history: read(),

  // One tool, one hint: replace/patch overwrite, so write is destructive.
  write: destructive(),
  delete: destructive(),
  move: destructive(),
  restore: destructive(),
  // gather is read-only; finalize archives by rewriting the path column.
  lint: destructive(),
  register_namespace: additive(),
  update_namespace: destructive(),

  list_repo_tree: read(),
  read_repo_file: read(),
  search_code: read(),
  repo_refs: read(),
  repo_history: read(),
  ci_status: read(),
  write_repo_file: destructive(),
  create_branch: additive(),
  open_pr: additive(),
  delete_repo_file: destructive(),
  manage_pr: destructive(),
  delete_branch: destructive(),
  ci_dispatch: additive(),

  improve_status: read(),
  improve_run: destructive(),

  // The work queue. complete, fail and block overwrite result_summary and move a
  // job out of claimed, and the mirrored document is rewritten on every
  // transition, so the tool can overwrite existing state.
  jobs: destructive(),

  // The credential control plane. revoke and update_scopes both overwrite existing
  // state: one ends a credential, the other changes what it may do.
  agents: destructive(),

  // Claims apart from verified outcomes. The handler only reads, but readOnlyHint is
  // the negation of the write gate (test/tool-annotations.test.ts), and "admin" is the
  // write grant plus the admin identity, so it is served as not read-only. It
  // overwrites and removes nothing, so it is not destructive either. A client that
  // asks before a non-read-only call asks here too, which costs the admin one click.
  claims: additive(),

  // The watcher's last pass, read from one KV value. Admin, so not read-only under the
  // same rule as claims, and it overwrites and removes nothing.
  ops_snapshot: additive(),
};

// Object.hasOwn, not a bare index: "constructor" is not a missing tool.
export function hintsFor(tool: string): ToolHints {
  if (!Object.hasOwn(TOOL_HINTS, tool)) {
    // Fail closed: a new tool is under-claimed until the table catches up.
    return { readOnlyHint: false, destructiveHint: true };
  }
  return TOOL_HINTS[tool];
}
