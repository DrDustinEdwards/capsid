import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { POLICY_OVERRIDE_FLAGS } from "../scope";
import { toolSurfaceOf } from "./surface";
import { NAMESPACE_DELETE_MAX_DOCUMENTS } from "../namespace-delete";
import { performNamespaceDelete, previewNamespaceDelete } from "../namespace-delete-perform";
import { registerNamespace, registerRepos, updateNamespace, updateRepos } from "../namespace-admin";
import { driverMintInstruction } from "../agents-schema";
import { bounded, MAX_CONFIRM_TOKEN, MAX_REPO_SELECTOR, MAX_REPOS_JSON, nsName } from "../limits";
import { ok, fail, type ToolCtx } from "./docs";

export function defineNamespaceOperations(server: McpServer, ctx: ToolCtx): void {
  const { env, db, actor } = ctx;

  ctx.ops.define(
    "namespaces",
    {
      description:
        "List the namespaces this caller is scoped to and the repos each maps to. A scoped agent sees only its own namespaces.",
      inputSchema: {},
    },
    async () => {
      // unconsolidated: episodic and source docs the lint loop has not archived, so every session
      // sees which namespaces need a run.
      const { results } = await db
        .prepare(
          `SELECT n.namespace, n.repos, n.created_at,
                  (SELECT COUNT(*) FROM documents d
                   WHERE d.namespace = n.namespace AND d.type IN ('episodic', 'source')
                     AND d.path NOT LIKE 'archive/%') AS unconsolidated
           FROM namespaces n ORDER BY n.namespace`,
        )
        .all();
      // Filtered to the caller's own namespaces: this tool takes no arguments, so the registrar's
      // namespaceRefusal has nothing to fire on, and the mapping is the shape of the boundary the
      // caller sits behind.
      const scoped = ctx.agent.scopes.namespaces;
      const visible =
        scoped === "*"
          ? results
          : results.filter((row) =>
              scoped.includes(String((row as { namespace: string }).namespace)),
            );
      return ok(visible);
    },
  );

  // Create-only: it will not overwrite a mapping. Admin only (TOOL_GRANTS in src/scope.ts); writing
  // documents to a new label does not register it.
  ctx.ops.define(
    "register_namespace",
    {
      description:
        'Register a namespace in the namespaces table. Give repo as \'owner/name\' (label defaults to \'primary\'), or pass a repos JSON array like [{"repo":"owner/name","label":"primary"}] for a multi-repo namespace. Refused if the namespace exists. Admin only: an OAuth session qualifies, a minted agent holding the write grant does not.',
      inputSchema: {
        namespace: nsName,
        repo: bounded(MAX_REPO_SELECTOR).optional(),
        label: bounded(MAX_REPO_SELECTOR).optional(),
        repos: bounded(MAX_REPOS_JSON).optional(),
      },
    },
    async ({ namespace, repo, label, repos }) => {
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      const mapped = registerRepos({ repo, label, repos });
      if (!mapped.ok) return fail(mapped.refusal);
      const list = mapped.list;
      const registered = await registerNamespace(db, actor, ns, list);
      if (!registered.ok) return fail(registered.refusal);
      return ok({
        namespace: ns,
        repos: list,
        action: "registered",
        driver_agent: null,
        next: driverMintInstruction(ns),
      });
    },
  );

  // Does not rename the namespace: a rename touches document keys, versions and audit history.
  ctx.ops.define(
    "update_namespace",
    {
      description:
        'Remap an existing namespace\'s repos. Pass repos as a JSON array like [{"repo":"owner/name","label":"primary"},{"repo":"owner/legacy","label":"legacy"}], with exactly one entry labeled "primary". The namespace must exist. Records the prior mapping in the audit log. Does not rename the namespace or move its documents. Admin only: an OAuth session qualifies, a minted agent holding the write grant does not.',
      inputSchema: { namespace: nsName, repos: bounded(MAX_REPOS_JSON) },
    },
    async ({ namespace, repos }) => {
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      const mapped = updateRepos(repos);
      if (!mapped.ok) return fail(mapped.refusal);
      const updated = await updateNamespace(db, actor, ns, mapped.list);
      if (!updated.ok) return fail(updated.refusal);
      return ok({
        namespace: ns,
        repos: mapped.list,
        action: "updated",
        previous: updated.previous,
      });
    },
  );
  // Preview counts everything naming the namespace and signs a token; perform re-plans and commits
  // one guarded batch. Admin only (TOOL_GRANTS in src/scope.ts).
  ctx.ops.define(
    "delete_namespace",
    {
      description: `Delete a registered namespace. Two calls. action 'delete_preview' writes nothing: it counts every live and archived document, snapshot, edge, agent naming the namespace, and the ops_sites row, and returns a verdict. It is refused while any live agent names it in its scopes (cascade never reaches agents; end them with capsid_admin_manage_agents), while it is on the roster, while live documents exist and cascade is not true, while it holds policy documents (policy/) and allow_policy_paths is not true, and while it holds more live documents than one batch deletes (${NAMESPACE_DELETE_MAX_DOCUMENTS}; delete some with capsid_delete_doc or move them with capsid_write_doc action move first). An allowed preview returns a token bound to the namespace, cascade, allow_policy_paths, the counts and this caller, valid five minutes. action 'delete_perform' takes the same arguments and that token, re-reads the plan and refuses if anything counted changed, then in one batch snapshots every live document to document_versions and deletes it with the edges touching it, deletes the ops_sites row and the namespaces row, and writes one audit row 'namespace-delete' holding the edges and both rows whole. Archived documents, versions and the audit log are kept. Admin only: an OAuth session qualifies, a minted agent holding the write grant does not.`,
      inputSchema: {
        namespace: nsName,
        action: z.enum(["preview", "perform"]),
        cascade: z.boolean().optional(),
        allow_policy_paths: z.boolean().optional(),
        token: bounded(MAX_CONFIRM_TOKEN).optional(),
      },
    },
    async ({ namespace, action, cascade, allow_policy_paths, token }) => {
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      const opts = { cascade: cascade === true, allowPolicyPaths: allow_policy_paths === true };
      // The policy override is scoped as it is on a document delete: the flag is the
      // permission, the argument only the caller's intent.
      if (opts.allowPolicyPaths) {
        const overrideRefusal = ctx.scope({
          ...toolSurfaceOf("delete_namespace", "perform"),
          namespace: ns,
          flags: POLICY_OVERRIDE_FLAGS,
        });
        if (overrideRefusal) return fail(overrideRefusal);
      }
      const now = new Date();
      const answer =
        action === "preview"
          ? await previewNamespaceDelete(env, actor, ns, opts, now)
          : await performNamespaceDelete(env, actor, ns, opts, token, now);
      return answer.ok ? ok(answer.data) : fail(answer.refusal);
    },
  );
}
