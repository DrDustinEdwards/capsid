// A cache. test/tool-annotations.test.ts derives each flag from the handler and
// fails both directions. readOnlyHint is the negation of the write gate.
// destructiveHint is true iff a write-gated handler can overwrite or remove
// existing state.
//
// idempotentHint and openWorldHint were once dropped because a TRANSITIVE "calls
// github.ts" scan disagreed with the table twice. They are back, derived from a
// DIRECT scan of each registration block plus a named override list in the test,
// each override with its reason:
// - openWorldHint is true iff the block calls into src/github* or
//   src/ops-cloudflare.ts, or the override list names a call made through another
//   module (jobs, improve_run).
// - idempotentHint is true for every read-only tool. For a write it is an explicit
//   table in the test, one reason per tool, and a scan fails any tool marked
//   idempotent whose block creates something new on each call.
// The protocol's defaults when a hint is omitted are idempotent false and open world
// true, so both are stated for every tool rather than left to a client's reading.

export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

// What a call reaches and whether repeating it changes anything. Optional so an
// entry written with a bare constructor still compiles; the defaults are the
// conservative ones (repeatable effects, open world), and the test refuses an entry
// that leaves either unstated.
interface Reach {
  idempotent?: boolean;
  openWorld?: boolean;
}

const reach = (r: Reach) => ({ idempotentHint: r.idempotent ?? false, openWorldHint: r.openWorld ?? true });

const read = (r: Reach = {}): ToolHints => ({ readOnlyHint: true, destructiveHint: false, ...reach(r) });
const additive = (r: Reach = {}): ToolHints => ({ readOnlyHint: false, destructiveHint: false, ...reach(r) });
const destructive = (r: Reach = {}): ToolHints => ({ readOnlyHint: false, destructiveHint: true, ...reach(r) });

export const TOOL_HINTS: Record<string, ToolHints> = {
  list: read({ idempotent: true, openWorld: false }),
  read: read({ idempotent: true, openWorld: false }),
  brief: read({ idempotent: true, openWorld: false }),
  backlinks: read({ idempotent: true, openWorld: false }),
  find: read({ idempotent: true, openWorld: false }),
  search: read({ idempotent: true, openWorld: false }),
  namespaces: read({ idempotent: true, openWorld: false }),
  history: read({ idempotent: true, openWorld: false }),

  // One tool, one hint: replace/patch overwrite, so write is destructive. append adds
  // to the body again and every overwrite snapshots a new version, so not idempotent.
  write: destructive({ idempotent: false, openWorld: false }),
  // A repeat finds nothing to delete or move and is refused.
  delete: destructive({ idempotent: true, openWorld: false }),
  move: destructive({ idempotent: true, openWorld: false }),
  // Each restore snapshots the live body first, so a repeat adds a version.
  restore: destructive({ idempotent: false, openWorld: false }),
  // gather is read-only; finalize archives by rewriting the path column. gather
  // reads the repo tree from GitHub, and a second report the same day snapshots the
  // first.
  lint: destructive({ idempotent: false, openWorld: true }),
  // A repeat is refused, but the create is an INSERT the idempotence scan cannot tell
  // from a repeating one, so it is not claimed.
  register_namespace: additive({ idempotent: false, openWorld: false }),
  // Sets the mapping to the value given; a repeat sets the same mapping.
  update_namespace: destructive({ idempotent: true, openWorld: false }),
  // Deletes the namespaces row, its ops_sites row and, with cascade, every live
  // document; preview writes nothing, but one tool carries one hint. A repeat finds no
  // namespace and is refused.
  delete_namespace: destructive({ idempotent: true, openWorld: false }),

  list_repo_tree: read({ idempotent: true, openWorld: true }),
  read_repo_file: read({ idempotent: true, openWorld: true }),
  search_code: read({ idempotent: true, openWorld: true }),
  repo_refs: read({ idempotent: true, openWorld: true }),
  repo_history: read({ idempotent: true, openWorld: true }),
  ci_status: read({ idempotent: true, openWorld: true }),
  // Every call is a new commit, or a new pull request in pr mode.
  write_repo_file: destructive({ idempotent: false, openWorld: true }),
  // GitHub refuses a branch that exists.
  create_branch: additive({ idempotent: true, openWorld: true }),
  // GitHub refuses a duplicate only while the first is open; after a close or merge a
  // repeat opens another.
  open_pr: additive({ idempotent: false, openWorld: true }),
  // A repeat finds the file or branch gone and is refused.
  delete_repo_file: destructive({ idempotent: true, openWorld: true }),
  // comment posts a new comment on every call.
  manage_pr: destructive({ idempotent: false, openWorld: true }),
  delete_branch: destructive({ idempotent: true, openWorld: true }),
  // Every call starts a new workflow run.
  ci_dispatch: additive({ idempotent: false, openWorld: true }),

  improve_status: read({ idempotent: true, openWorld: false }),
  // run advances every open run a step and can dispatch a workflow or open a pull
  // request; mint_operator_key issues a new key each call.
  improve_run: destructive({ idempotent: false, openWorld: true }),

  // The work queue. complete, fail and block overwrite result_summary and move a
  // job out of claimed, and the mirrored document is rewritten on every
  // transition, so the tool can overwrite existing state. post creates a job each
  // call. complete and fail check their evidence against GitHub, and start_seat sends
  // a repository dispatch, both through other modules.
  jobs: destructive({ idempotent: false, openWorld: true }),

  // The credential control plane. revoke and update_scopes both overwrite existing
  // state: one ends a credential, the other changes what it may do. mint issues a new
  // credential each call.
  agents: destructive({ idempotent: false, openWorld: false }),

  // Claims apart from verified outcomes. The handler only reads, but readOnlyHint is
  // the negation of the write gate (test/tool-annotations.test.ts), and "admin" is the
  // write grant plus the admin identity, so it is served as not read-only. It
  // overwrites and removes nothing, so it is not destructive either. A client that
  // asks before a non-read-only call asks here too, which costs the admin one click.
  claims: additive({ idempotent: true, openWorld: false }),

  // The watcher's last pass, read from one KV value. Admin, so not read-only under the
  // same rule as claims, and it overwrites and removes nothing.
  ops_snapshot: additive({ idempotent: true, openWorld: false }),
};

// Object.hasOwn, not a bare index: "constructor" is not a missing tool.
export function hintsFor(tool: string): ToolHints {
  if (!Object.hasOwn(TOOL_HINTS, tool)) {
    // Fail closed: a new tool is under-claimed until the table catches up.
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  return TOOL_HINTS[tool];
}
