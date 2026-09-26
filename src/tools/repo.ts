import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import {
  CI_DISPATCH_POLL_MS,
  CI_LOG_BUDGET,
  ciDispatch,
  ciStatus,
  createBranch,
  deleteBranch,
  deleteRepoFile,
  listRepoTree,
  managePr,
  openPr,
  readRepoFile,
  readRepoFiles,
  REPO_BATCH_MAX_FILES,
  REPO_FILE_BUDGET,
  REPO_HISTORY_DEFAULT_LIMIT,
  REPO_HISTORY_MAX_LIMIT,
  REPO_PATCH_BUDGET,
  repoHistory,
  repoRefs,
  searchCode,
  writeRepoFile,
} from "../github";
import { bounded, CI_DISPATCH_MAX_INPUTS, DEFAULT_SCAN_FILES, DEFAULT_SCAN_RESULTS, MAX_BODY, MAX_COMMIT_MESSAGE, MAX_PATH, MAX_PR_BODY, MAX_PR_COMMENT, MAX_PR_TITLE, MAX_QUERY, MAX_REF, MAX_REPO_SELECTOR, MAX_SCAN_CAP, MAX_SHA, nsName } from "../limits";
import { fail, type ToolCtx } from "./docs";
import { repoGuards } from "./repo-guards";

import { HeadMovedError } from "../github/refs";
import { reverifyPr } from "../outcome-prs";

// The pull request's canonical URL, for a managePr result that did not carry one.
// The merge response names the repo and the caller named the number, which is all a
// GitHub pull request URL is.
function prUrlFor(result: { repo?: string }, number: number): string {
  return `https://github.com/${result.repo ?? ""}/pull/${number}`;
}

// manage_pr's sha belongs to action 'merge' only. Thrown rather than returned, because
// guardedWrite reports a value returned from its callback as success.
function refuseShaOffMerge(action: string, sha: string | undefined): void {
  if (action !== "merge" && sha !== undefined) throw new Error(`manage_pr action '${action}' takes no sha; only action 'merge' pins the head.`);
}

// A merge pinned to a sha that GitHub refused with 409 because the head moved. Rethrown
// with a message that says so, so guardedWrite reports it as a refusal. Any other error
// passes through unchanged.
function headMovedRefusal(number: number) {
  return (err: unknown): never => {
    if (err instanceof HeadMovedError) {
      throw new Error(
        `merge refused, nothing was merged: the head of pull request ${number} moved and is no longer ${err.expectedSha}. Read the pull request again, review the new head, and merge with its sha. Detail: ${err.message}`
      );
    }
    throw err;
  };
}

export function registerRepoTools(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;
  const { guardedRead, guardedWrite } = repoGuards(ctx);

  // Repo fallthrough: live GitHub access via the Capsid GitHub App. Reads are
  // open to any admitted client; writes require the write grant (TOOL_GRANTS in
  // src/scope.ts). The target repo is resolved per namespace from the namespaces
  // table.

  // A namespace can map to more than one repo. The optional `repo` argument on every repo tool selects one: a
  // label ("primary", "legacy") or a full "owner/name" mapped to the namespace. Omit
  // it to target the primary. `namespaces` shows the mapping.
  const REPO_ARG = "A repo label or mapped \"owner/name\". Defaults to the primary repo.";

  server.registerTool(
    "list_repo_tree",
    {
      annotations: hintsFor("list_repo_tree"),
      description: "List a directory in a namespace's GitHub repo. Omit path for the repo root. Live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, path: bounded(MAX_PATH).optional(), ref: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, path, ref, repo }) => guardedRead("list_repo_tree", namespace, repo, () => listRepoTree(env, namespace, path ?? "", ref, repo))
  );

  server.registerTool(
    "read_repo_file",
    {
      annotations: hintsFor("read_repo_file"),
      description: `Read a file from a namespace's GitHub repo, decoded to text. Optional ref (branch, tag, or sha). Live GitHub, briefly cached. Pass EITHER path for one file, or paths for up to ${REPO_BATCH_MAX_FILES} in one call; in the batch form each file succeeds or fails on its own, and each is capped at ${REPO_FILE_BUDGET} bytes with truncated:true when it is cut. REFUSES: both path and paths together, neither of them, an empty paths array, more than ${REPO_BATCH_MAX_FILES} paths, and a directory (use list_repo_tree).`,
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH).optional(),
        paths: z
          .array(bounded(MAX_PATH))
          .max(REPO_BATCH_MAX_FILES)
          .optional()
          .describe(`Up to ${REPO_BATCH_MAX_FILES} paths, read independently. Alternative to path, not combinable with it.`),
        ref: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, paths, ref, repo }) =>
      guardedRead("read_repo_file", namespace, repo, () => {
        // EXACTLY ONE OF THE TWO. Accepting both and preferring one would make the
        // ignored argument invisible.
        if (path && paths) throw new Error("read_repo_file: pass path for one file or paths for several, not both");
        if (!path && !paths) throw new Error("read_repo_file: pass path for one file, or paths for several");
        return paths ? readRepoFiles(env, namespace, paths, ref, repo) : readRepoFile(env, namespace, path as string, ref, repo);
      })
  );

  server.registerTool(
    "search_code",
    {
      annotations: hintsFor("search_code"),
      description:
        "Case-insensitive substring search across a namespace repo's files. Scans blobs server-side, so scope large repos with path_prefix. Returns path, line number and the matching line. A scan that stops early sets truncated:true with a note and a next_start to resume from; a truncated result is a partial scan.",
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName,
        path_prefix: bounded(MAX_PATH).optional().describe("Only scan files whose path starts with this prefix, e.g. 'app/lib/billing'."),
        ref: bounded(MAX_REF).optional().describe("Branch, tag, or sha to search. Defaults to the default branch."),
        max_results: z.number().int().positive().optional().describe(`Cap on returned matches (default ${DEFAULT_SCAN_RESULTS}, max ${MAX_SCAN_CAP}).`),
        max_files: z.number().int().positive().optional().describe(`Cap on files fetched and scanned (default ${DEFAULT_SCAN_FILES}, max ${MAX_SCAN_CAP}). Each file costs one GitHub request; resume a wider sweep with start.`),
        start: z.number().int().nonnegative().optional().describe("Candidate-file offset to resume a truncated scan; pass the previous result's next_start."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ query, namespace, path_prefix, ref, max_results, max_files, start, repo }) =>
      guardedRead("search_code", namespace, repo, () =>
        searchCode(env, namespace, query, {
          pathPrefix: path_prefix,
          ref,
          maxResults: max_results,
          maxFiles: max_files,
          start,
          repoSelector: repo,
        })
      )
  );

  server.registerTool(
    "write_repo_file",
    {
      annotations: hintsFor("write_repo_file"),
      description:
        "Write a file to a namespace's GitHub repo. mode 'pr' (default) commits to a new branch, or to branch if given, and opens a PR; mode 'direct' commits straight to the default branch. Mode 'pr' REFUSES branch set to the default branch, and a branch that already has an open PR unless pr names that PR's number. REFUSES any path under .github/workflows/ unless allow_workflow_write: true is passed. mode 'direct' needs the can_direct_write flag, allow_workflow_write the can_write_workflows flag, a protected path can_touch_protected and a money path money_paths. Needs the write grant.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH),
        content: bounded(MAX_BODY),
        message: bounded(MAX_COMMIT_MESSAGE),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        allow_workflow_write: z
          .boolean()
          .optional()
          .describe(
            "Opt in to writing under .github/workflows/, which is refused without it. Needs the can_write_workflows flag; audit-logged."
          ),
        pr: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "The number of branch's open pull request, required when branch has one; the commit then lands on it. Refused if it is not that branch's open pull request."
          ),
      },
    },
    ({ namespace, path, content, message, mode, branch, repo, allow_workflow_write, pr }) =>
      guardedWrite(
        "write_repo_file",
        namespace,
        path,
        () => writeRepoFile(env, namespace, path, content, message, mode ?? "pr", branch, repo, allow_workflow_write, pr),
        { path, mode: mode ?? "pr", allow_workflow_write, repo }
      )
  );

  server.registerTool(
    "create_branch",
    {
      annotations: hintsFor("create_branch"),
      description: "Create a branch in a namespace's GitHub repo. Branches off the default branch unless 'from' is given. Needs the write grant.",
      inputSchema: { namespace: nsName, branch: bounded(MAX_REF), from: bounded(MAX_REF).optional(), repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, branch, from, repo }) =>
      guardedWrite("create_branch", namespace, null, () => createBranch(env, namespace, branch, from, repo), { repo })
  );

  server.registerTool(
    "open_pr",
    {
      annotations: hintsFor("open_pr"),
      description: "Open a pull request in a namespace's GitHub repo. Base defaults to the repo's default branch. Needs the write grant.",
      inputSchema: {
        namespace: nsName,
        title: bounded(MAX_PR_TITLE),
        head: bounded(MAX_REF),
        base: bounded(MAX_REF).optional(),
        body: bounded(MAX_PR_BODY).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, title, head, base, body, repo }) =>
      guardedWrite("open_pr", namespace, null, () => openPr(env, namespace, title, head, base, body, repo), { repo })
  );

  server.registerTool(
    "delete_repo_file",
    {
      annotations: hintsFor("delete_repo_file"),
      description:
        "Delete a file from a namespace's GitHub repo. mode 'pr' (default) commits the deletion to a new branch, or to branch if given, and opens a PR; mode 'direct' deletes on the default branch. Mode 'pr' REFUSES branch set to the default branch, and a branch that already has an open PR unless pr names that PR's number. The file must exist. REFUSES any path under .github/workflows/ unless allow_workflow_write: true is passed. mode 'direct' needs the can_direct_write flag, allow_workflow_write the can_write_workflows flag, a protected path can_touch_protected and a money path money_paths. Needs the write grant.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH),
        message: bounded(MAX_COMMIT_MESSAGE),
        mode: z.enum(["pr", "direct"]).optional(),
        branch: bounded(MAX_REF).optional(),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        allow_workflow_write: z
          .boolean()
          .optional()
          .describe(
            "Opt in to writing under .github/workflows/, which is refused without it. Needs the can_write_workflows flag; audit-logged."
          ),
        pr: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "The number of branch's open pull request, required when branch has one; the commit then lands on it. Refused if it is not that branch's open pull request."
          ),
      },
    },
    ({ namespace, path, message, mode, branch, repo, allow_workflow_write, pr }) =>
      guardedWrite(
        "delete_repo_file",
        namespace,
        path,
        () => deleteRepoFile(env, namespace, path, message, mode ?? "pr", branch, repo, allow_workflow_write, pr),
        { path, mode: mode ?? "pr", allow_workflow_write, repo }
      )
  );

  server.registerTool(
    "manage_pr",
    {
      annotations: hintsFor("manage_pr"),
      description:
        "Merge, close or comment on an open pull request in a namespace's repo. action 'merge' uses merge_method (default 'squash') and needs the can_merge flag; with `sha`, it merges only if the head is still that commit and is otherwise refused with nothing merged. action 'close' closes it and needs the can_merge flag. action 'comment' posts `comment` and changes nothing else; it needs the can_comment_pr flag. Merge and close delete the head branch and return head_branch and head_branch_deleted, plus head_branch_note when the delete was declined: the default branch, a branch under the improve loop's prefix and a fork's branch are never deleted, and a failed delete does not fail the merge or close. A merge can trigger a deploy workflow. Needs the write grant.",
      inputSchema: {
        namespace: nsName,
        number: z.number().int().positive(),
        action: z.enum(["merge", "close", "comment"]),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
        comment: bounded(MAX_PR_COMMENT).optional().describe("For action 'comment': the comment body. Required for that action and refused for the others."),
        sha: bounded(MAX_SHA)
          .optional()
          .describe("For action 'merge': the full head sha you reviewed; the merge is refused if the head moved. Refused for the other actions."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, number, action, merge_method, comment, sha, repo }) => {
      // comment belongs to exactly one action, and is refused rather than ignored in
      // both directions: a comment silently dropped from a merge call is a review
      // nobody posted, and a comment on a merge is a caller who believes something
      // else is about to happen. Checked before guardedWrite, not inside it: guardedWrite files whatever fn
      // returns as a landed result. Refused here, the call is an error and writes no
      // audit row.
      if (action === "comment" && !comment) return fail("manage_pr action 'comment' needs a comment body.");
      if (action !== "comment" && comment !== undefined) {
        return fail(`manage_pr action '${action}' takes no comment; only action 'comment' posts one.`);
      }
      return guardedWrite(
        "manage_pr",
        namespace,
        null,
        async () => {
          refuseShaOffMerge(action, sha);
          const result = await managePr(env, namespace, number, action, merge_method ?? "squash", repo, comment, sha).catch(headMovedRefusal(number));
          // A merge makes the outcome rows naming this pull request stale, so they are
          // re-read from GitHub now rather than at the daily sweep. It never fails the
          // merge, which already happened: reporting it as failed because a
          // bookkeeping update did not land would misreport the merge, and the sweep
          // picks the row up either way.
          if (action === "merge") {
            try {
              const url = (result as { url?: string }).url ?? prUrlFor(result as { repo?: string }, number);
              const updated = await reverifyPr(env, namespace, url, new Date());
              if (updated.length > 0) {
                return { ...result, outcome_rows_updated: updated.filter((u) => u.changed).length };
              }
            } catch (err) {
              console.error(`OUTCOME_REVERIFY_FAILED pr ${number}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return result;
        },
        { action, repo }
      );
    }
  );

  server.registerTool(
    "ci_status",
    {
      annotations: hintsFor("ci_status"),
      description: `Recent CI workflow runs for a namespace's repo (name, head sha, status, conclusion, timestamps). Optional ref narrows to one branch or head sha; optional run_id returns just that run. For the most recent failed run it also returns the failing jobs and steps and, for a write-grant caller, the failing step's log, up to ${CI_LOG_BUDGET} bytes from its end, with log_region naming the region returned. A read-only caller gets a note that the log was withheld. REFUSES: a run_id that does not exist on the repo. Read-only.`,
      inputSchema: {
        namespace: nsName,
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
        limit: z.number().int().positive().optional().describe("How many recent runs to return (default 10, max 20)."),
        ref: bounded(MAX_REF)
          .optional()
          .describe("Narrow to one branch or head sha. A hex object name is filtered as a sha, anything else as a branch."),
        run_id: z.number().int().positive().optional().describe("Return only this run, by its GitHub run id."),
      },
    },
    ({ namespace, repo, limit, ref, run_id }) =>
      // The log tail is withheld from a read-only caller: a build log carries whatever
      // the workflow echoed. Asked of checkScope rather than decided here.
      guardedRead("ci_status", namespace, repo, () =>
        ciStatus(env, namespace, repo, {
          limit,
          logTail: ctx.scope({ tool: "ci_status", namespace, grant: "write" }) === null,
          ref,
          runId: run_id,
        })
      )
  );

  // repo_refs and repo_history are reads and stay open to ro: keys. delete_branch and
  // ci_dispatch need the write grant: one destroys refs, the other spends CI minutes
  // and can start a deploy. These four are a ruled exception to the tool surface
  // rule (CLAUDE.md; capsid/decisions.md).

  server.registerTool(
    "repo_refs",
    {
      annotations: hintsFor("repo_refs"),
      description:
        "What is in flight in a namespace's repo, in one call: branches (name, head sha, last commit date, ahead/behind the default branch, and the open PR number if the branch has one), tags, and open pull requests. Sets truncated:true when any of the three lists hit its 100-item page. Read-only, live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG) },
    },
    ({ namespace, repo }) => guardedRead("repo_refs", namespace, repo, () => repoRefs(env, namespace, repo))
  );

  server.registerTool(
    "repo_history",
    {
      annotations: hintsFor("repo_history"),
      description: `Commits, a comparison, or one commit, chosen by which argument is present: ref for the commits on a ref (default ${REPO_HISTORY_DEFAULT_LIMIT}, max ${REPO_HISTORY_MAX_LIMIT}); base and head together for a comparison (ahead/behind, the commit list, and changed files with status and line counts); sha for one commit (full message, parents, changed files). Patch bodies are omitted unless patch:true, and are then budgeted to ${REPO_PATCH_BUDGET} bytes across the whole response with patch_truncated:true when the budget runs out. Commit subjects are the first line only; read one commit by sha for its whole message. REFUSES: more than one of sha / base+head / ref; base without head or head without base; and none of them. Read-only.`,
      inputSchema: {
        namespace: nsName,
        ref: bounded(MAX_REF).optional().describe("Commits on this branch, tag or sha."),
        base: bounded(MAX_REF).optional().describe("Comparison base. Requires head."),
        head: bounded(MAX_REF).optional().describe("Comparison head. Requires base."),
        sha: bounded(MAX_SHA).optional().describe("One commit, in full."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How many commits (default ${REPO_HISTORY_DEFAULT_LIMIT}, max ${REPO_HISTORY_MAX_LIMIT}).`),
        patch: z.boolean().optional().describe("Include patch bodies, budgeted. Off by default."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, ref, base, head, sha, limit, patch, repo }) =>
      guardedRead("repo_history", namespace, repo, () => repoHistory(env, namespace, { ref, base, head, sha, limit, patch }, repo))
  );

  server.registerTool(
    "delete_branch",
    {
      annotations: hintsFor("delete_branch"),
      description:
        "Delete a branch in a namespace's GitHub repo. REFUSES, naming the refusal: the default branch, always; a branch under the improve loop's prefix; a branch with an open pull request; and a branch that does not exist. force:true lifts the prefix and open-PR refusals and needs the can_merge flag. Needs the write grant; audit-logged.",
      inputSchema: {
        namespace: nsName,
        branch: bounded(MAX_REF),
        force: z
          .boolean()
          .optional()
          .describe("Lift the improve-prefix and open-PR refusals. Requires the can_merge flag. Does NOT lift the default-branch refusal."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, branch, force, repo }) =>
      guardedWrite("delete_branch", namespace, null, () => deleteBranch(env, namespace, branch, { force }, repo), { force, repo })
  );

  server.registerTool(
    "ci_dispatch",
    {
      annotations: hintsFor("ci_dispatch"),
      description: `Start a workflow, or rerun one's failed jobs. Pass workflow (the file name, e.g. ci.yml) and ref to trigger a workflow_dispatch; it polls for up to ${CI_DISPATCH_POLL_MS / 1000}s and returns the new run's run_id, or run_id null with a note when no run appeared. Pass run_id alone to rerun that run's failed jobs. REFUSES: a workflow with no workflow_dispatch trigger, and workflow together with run_id. Needs the write grant and the can_dispatch flag; audit-logged. Spends CI minutes and can start a deploy.`,
      inputSchema: {
        namespace: nsName,
        workflow: bounded(MAX_PATH).optional().describe("Workflow file name, e.g. ci.yml. Requires ref."),
        ref: bounded(MAX_REF).optional().describe("The branch or sha to run the workflow on. Requires workflow."),
        run_id: z.number().int().positive().optional().describe("Rerun this run's failed jobs. Not combinable with workflow."),
        inputs: z
          .record(bounded(MAX_REF), bounded(MAX_REF))
          .refine((map) => Object.keys(map).length <= CI_DISPATCH_MAX_INPUTS, {
            message: `at most ${CI_DISPATCH_MAX_INPUTS} workflow inputs: GitHub's own workflow_dispatch ceiling is ${CI_DISPATCH_MAX_INPUTS}, so a larger map can never be valid`,
          })
          .optional()
          .describe("workflow_dispatch inputs, as a flat string map."),
        repo: bounded(MAX_REPO_SELECTOR).optional().describe(REPO_ARG),
      },
    },
    ({ namespace, workflow, ref, run_id, inputs, repo }) =>
      guardedWrite(
        "ci_dispatch",
        namespace,
        null,
        () => ciDispatch(env, namespace, { workflow, ref, run_id, inputs }, repo),
        // The workflow file name is the path this dispatch runs, so a dispatch of a
        // workflow under a protected or money path is checked as one.
        { path: workflow, repo }
      )
  );
}
