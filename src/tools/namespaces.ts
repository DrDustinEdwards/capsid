import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hintsFor } from "../tool-annotations";
import { IMPROVE_OVERRIDE_FLAGS } from "../scope";
import { NAMESPACE_DELETE_MAX_DOCUMENTS, performNamespaceDelete, previewNamespaceDelete } from "../namespace-delete";
import { parseReposList, REPO_SHAPE, requireSinglePrimary } from "../github";
import { auditStatement } from "../store-guards";
import { driverMintInstruction } from "../agents-schema";
import { bounded, MAX_CONFIRM_TOKEN, MAX_REPO_SELECTOR, MAX_REPOS_JSON, nsName } from "../limits";
import { ok, fail, type ToolCtx } from "./docs";

// The namespace tools: namespaces, register_namespace, update_namespace and
// delete_namespace.
// registerDocTools in ./docs registers them after the document tools.

export function registerNamespaceTools(server: McpServer, ctx: ToolCtx): void {
  const { env, db, actor } = ctx;

  server.registerTool(
    "namespaces",
    {
      annotations: hintsFor("namespaces"),
      description:
        "List the namespaces this caller is scoped to and the repos each maps to. A scoped agent sees only its own namespaces.",
      inputSchema: {},
    },
    async () => {
      // unconsolidated = episodic and source docs not yet archived by the lint loop,
      // surfaced so every session sees which namespaces need a run. Not filtered on
      // status: the archive/ prefix is the only thing that takes a doc out of the loop.
      const { results } = await db
        .prepare(
          `SELECT n.namespace, n.repos, n.created_at,
                  (SELECT COUNT(*) FROM documents d
                   WHERE d.namespace = n.namespace AND d.type IN ('episodic', 'source')
                     AND d.path NOT LIKE 'archive/%') AS unconsolidated
           FROM namespaces n ORDER BY n.namespace`
        )
        .all();
      // Filtered to the caller's own namespaces. This tool takes no arguments, so
      // namespaceRefusal at the registrar has nothing to fire on. The mapping is what
      // scripts/mint-agents.mjs uses to set the repos axis and what resolveRepo
      // resolves through, so handing it to a narrowed caller hands it the shape of the
      // boundary it sits behind.
      const scoped = ctx.agent.scopes.namespaces;
      const visible = scoped === "*" ? results : results.filter((row) => scoped.includes(String((row as { namespace: string }).namespace)));
      return ok(visible);
    }
  );

  // Register a namespace: the one row in the namespaces table that repo tools and the
  // namespaces list read. Writing documents to a new namespace label does not create
  // it. Create-only: it will not overwrite an existing mapping. Admin only (TOOL_GRANTS in src/scope.ts): an OAuth
  // session qualifies, a minted agent holding the write grant does not.
  server.registerTool(
    "register_namespace",
    {
      annotations: hintsFor("register_namespace"),
      description:
        "Register a namespace in the namespaces table. Give repo as 'owner/name' (label defaults to 'primary'), or pass a repos JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"}] for a multi-repo namespace. Refused if the namespace exists. Admin only: an OAuth session qualifies, a minted agent holding the write grant does not.",
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
      let list: Array<{ repo: string; label: string }>;
      if (repos) {
        const parsed = parseReposList(repos);
        if ("error" in parsed) return fail(parsed.error);
        list = parsed.list;
      } else {
        if (!repo || !REPO_SHAPE.test(repo)) {
          return fail('provide repo as "owner/name", or pass a repos JSON array');
        }
        list = [{ repo, label: (label ?? "primary").trim() || "primary" }];
      }
      // The same single-primary requirement as update_namespace. Two primaries or none
      // would make every repo tool resolve by accident, and update would refuse to fix
      // it in place.
      const primaryError = requireSinglePrimary(list);
      if (primaryError) return fail(primaryError);
      const existing = await db.prepare("SELECT namespace FROM namespaces WHERE namespace = ?1").bind(ns).first();
      if (existing) {
        return fail(`namespace already registered: ${ns}. Use update_namespace to change its repo mapping; it snapshots the prior mapping to the audit log.`);
      }
      const reposJson = JSON.stringify(list);
      await db.batch([
        db.prepare("INSERT INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(ns, reposJson),
        auditStatement(db, actor, "register_namespace", ns, null, list),
      ]);
      return ok({
        namespace: ns,
        repos: list,
        action: "registered",
        driver_agent: null,
        next: driverMintInstruction(ns),
      });
    }
  );

  // Remap an existing namespace's repos; register_namespace is the create path.
  // Snapshots the prior mapping to the audit log. It does not rename the namespace: a
  // rename touches document keys, versions and audit history.
  server.registerTool(
    "update_namespace",
    {
      annotations: hintsFor("update_namespace"),
      description:
        "Remap an existing namespace's repos. Pass repos as a JSON array like [{\"repo\":\"owner/name\",\"label\":\"primary\"},{\"repo\":\"owner/legacy\",\"label\":\"legacy\"}], with exactly one entry labeled \"primary\". The namespace must exist. Records the prior mapping in the audit log. Does not rename the namespace or move its documents. Admin only: an OAuth session qualifies, a minted agent holding the write grant does not.",
      inputSchema: { namespace: nsName, repos: bounded(MAX_REPOS_JSON) },
    },
    async ({ namespace, repos }) => {
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      const parsed = parseReposList(repos);
      if ("error" in parsed) return fail(parsed.error);
      const list = parsed.list;
      const primaryError = requireSinglePrimary(list);
      if (primaryError) return fail(primaryError);
      const existing = await db
        .prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
        .bind(ns)
        .first<{ repos: string }>();
      if (!existing) return fail(`namespace not found: ${ns}. Use register_namespace to create it.`);
      const reposJson = JSON.stringify(list);
      await db.batch([
        db.prepare("UPDATE namespaces SET repos = ?2 WHERE namespace = ?1").bind(ns, reposJson),
        auditStatement(db, actor, "update_namespace", ns, null, { old: existing.repos, new: reposJson }),
      ]);
      return ok({ namespace: ns, repos: list, action: "updated", previous: existing.repos });
    }
  );
  // Delete a namespace: a preview that counts everything naming it and signs a token,
  // then a perform that re-plans, requires the token to match and commits one guarded
  // batch. The rules and what is kept are in src/namespace-delete.ts. Admin only
  // (TOOL_GRANTS in src/scope.ts), like the other two tools that edit the mapping.
  server.registerTool(
    "delete_namespace",
    {
      annotations: hintsFor("delete_namespace"),
      description:
        `Delete a registered namespace. Two calls. action 'preview' writes nothing: it counts every live and archived document, snapshot, edge, job by status, agent naming the namespace, the ops_sites row, improve rows and KV keys, and returns a verdict. It is refused while any job in the namespace is open (queued, claimed or blocked) or any live agent names it in its scopes (cascade never reaches jobs or agents; end them with the jobs or agents tool), while it is on the improve roster, while live documents exist and cascade is not true, while it holds improve loop control documents and allow_improve_paths is not true, and while it holds more live documents than one batch deletes (${NAMESPACE_DELETE_MAX_DOCUMENTS}; delete or move some with the delete tool first). An allowed preview returns a token bound to the namespace, cascade, allow_improve_paths, the counts and this caller, valid five minutes. action 'perform' takes the same arguments and that token, re-reads the plan and refuses if anything counted changed, then in one batch snapshots every live document to document_versions and deletes it with the edges touching it, deletes the ops_sites row and the namespaces row, and writes one audit row 'namespace-delete' holding the edges and both rows whole; it then deletes the namespace's improve KV keys and reports any it could not. Archived documents, versions, the audit log, finished jobs and their records are kept. Admin only: an OAuth session qualifies, a minted agent holding the write grant does not.`,
      inputSchema: {
        namespace: nsName,
        action: z.enum(["preview", "perform"]),
        cascade: z.boolean().optional(),
        allow_improve_paths: z.boolean().optional(),
        token: bounded(MAX_CONFIRM_TOKEN).optional(),
      },
    },
    async ({ namespace, action, cascade, allow_improve_paths, token }) => {
      const ns = namespace.trim();
      if (!ns) return fail("namespace is required");
      const opts = { cascade: cascade === true, allowImprovePaths: allow_improve_paths === true };
      // The improve override is scoped as it is on a document delete: the flag is the
      // permission, the argument only the caller's intent.
      if (opts.allowImprovePaths) {
        const overrideRefusal = ctx.scope({ tool: "delete_namespace", namespace: ns, flags: IMPROVE_OVERRIDE_FLAGS });
        if (overrideRefusal) return fail(overrideRefusal);
      }
      const now = new Date();
      const answer =
        action === "preview"
          ? await previewNamespaceDelete(env, actor, ns, opts, now)
          : await performNamespaceDelete(env, actor, ns, opts, token, now);
      return answer.ok ? ok(answer.data) : fail(answer.refusal);
    }
  );
}
