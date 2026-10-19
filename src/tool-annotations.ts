// One honest set of hints per served tool (capsid/rulings/mcp-2026-10-10.md, rule 6),
// so a client can confirm before acting. A tool's hints hold for every action it takes:
// a tool with one action that writes is not read-only. test/tool-annotations.test.ts
// derives each flag and fails both directions:
// - readOnlyHint is true iff every action needs only the read grant (TOOL_GRANTS and
//   TOOL_ACTION_GRANTS in src/scope.ts): "read", or "admin_read" for an admin tool
//   that only reads.
// - destructiveHint is true iff some action can overwrite or remove existing state.
// - openWorldHint is true iff some operation the tool runs calls into src/github* or
//   the Cloudflare API, directly or through a named module.
// - idempotentHint is true for every read-only tool, and for a write only when a
//   repeat of any of its actions changes nothing further.
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
  // ---- Capsid (14)
  capsid_start_session: read({ idempotent: true, openWorld: false }),
  capsid_find_docs: read({ idempotent: true, openWorld: false }),
  capsid_read_doc: read({ idempotent: true, openWorld: false }),
  // write's replace and patch overwrite, restore overwrites the live body, and move
  // removes the old path. append adds again and every overwrite snapshots a new
  // version, so a repeat is not a no-op.
  capsid_write_doc: destructive({ idempotent: false, openWorld: false }),
  // A repeat finds nothing to delete and is refused.
  capsid_delete_doc: destructive({ idempotent: true, openWorld: false }),
  // gather reads the repo tree from GitHub; finalize archives by rewriting the path
  // column; a second report the same day snapshots the first.
  capsid_lint_namespace: destructive({ idempotent: false, openWorld: true }),
  capsid_read_repo: read({ idempotent: true, openWorld: true }),
  // The live site check fetches the site; the rest read GitHub.
  capsid_inspect_repo: read({ idempotent: true, openWorld: true }),
  // Every file write is a new commit, or a new pull request in pr mode.
  capsid_change_repo: destructive({ idempotent: false, openWorld: true }),
  // A comment posts a new comment on every call, and a repeat open after a close
  // opens another pull request. Nothing existing is overwritten.
  capsid_open_pr: additive({ idempotent: false, openWorld: true }),
  // merge and close end a pull request, delete removes a branch, and a release
  // publishes; a repeat release or tag is refused by GitHub, but a repeat close of a
  // reopened pull request is not a no-op.
  capsid_close_pr: destructive({ idempotent: false, openWorld: true }),
  // Every call starts a new workflow run.
  capsid_run_ci: additive({ idempotent: false, openWorld: true }),
  // complete, fail and block overwrite result_summary and move a job out of claimed;
  // post and record create a job each call; evidence is checked against GitHub.
  capsid_work_jobs: destructive({ idempotent: false, openWorld: true }),
  // Status only: Capsid's state from this Worker's own stores.
  capsid_run_improve: read({ idempotent: true, openWorld: false }),

  // ---- Capsid Admin (8)
  // Reads the queue, the Portal's stored state and GitHub's open pull requests.
  capsid_admin_whats_next: read({ idempotent: true, openWorld: true }),
  // update replaces the mapping, delete removes the namespace and, with cascade, its
  // documents; register creates one each call.
  capsid_admin_manage_namespaces: destructive({ idempotent: false, openWorld: false }),
  // revoke and update_scopes overwrite existing state; mint issues a new credential.
  capsid_admin_manage_agents: destructive({ idempotent: false, openWorld: false }),
  // Reads claims and their checks, never writes.
  capsid_admin_read_claims: read({ idempotent: true, openWorld: false }),
  // The watcher's pass from KV, and Cloudflare's API for Access, Email Routing and
  // Workers Builds.
  capsid_admin_read_ops: read({ idempotent: true, openWorld: true }),
  // perform can revoke an agent, fail a job or remove a site, and a confirmed token is
  // spent, so a repeat is refused rather than repeated. Only this Worker's own stores.
  capsid_admin_run_controls: destructive({ idempotent: false, openWorld: false }),
  // sign_policy overwrites a policy document (snapshotted), breaker_reset and overnight
  // overwrite their switches, and mint_operator_key issues a key each call. Only this
  // Worker's own stores.
  capsid_admin_control_improve: destructive({ idempotent: false, openWorld: false }),
  // Replaces a site's key on the site Worker and on Carrel through the Cloudflare API.
  capsid_admin_set_site_key: destructive({ idempotent: false, openWorld: true }),
};

// Object.hasOwn, not a bare index: "constructor" is not a missing tool.
export function hintsFor(tool: string): ToolHints {
  if (!Object.hasOwn(TOOL_HINTS, tool)) {
    // Fail closed: a new tool is under-claimed until the table catches up.
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  return TOOL_HINTS[tool];
}
