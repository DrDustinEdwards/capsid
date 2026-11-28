import { McpServer } from "@modelcontextprotocol/server";
import { toolSurfaceOf } from "./surface";
import { z } from "zod";
import {
  CI_JOBS_MAX,
  CI_LOG_BUDGET,
  ciStatus,
  deleteBranch,
  listRepoTree,
  managePr,
  pruneMergedBranches,
  readRepoFile,
  readRepoFiles,
  REPO_BATCH_MAX_FILES,
  REPO_FILE_BUDGET,
  REPO_HISTORY_DEFAULT_LIMIT,
  REPO_HISTORY_MAX_LIMIT,
  REPO_PATCH_BUDGET,
  repoHistory,
  repoRefs,
  searchAllRepos,
  searchCode,
} from "../github";
import {
  bounded,
  DEFAULT_SCAN_FILES,
  DEFAULT_SCAN_RESULTS,
  gitSha,
  MAX_CI_NAME,
  MAX_PATH,
  MAX_QUERY,
  MAX_REF,
  MAX_SCAN_CAP,
  nsName,
  repoSelector,
} from "../limits";
import { fail, type ToolCtx } from "./docs";
import { tagRelease } from "../github/releases";
import { repoGuards } from "./repo-guards";

import { HeadMovedError } from "../github/refs";

// Thrown rather than returned, because guardedWrite reports a value returned from its callback as
// success.
function refuseShaOffMerge(action: string, sha: string | undefined): void {
  if (action !== "merge" && sha !== undefined)
    throw new Error(
      `manage_pr action '${action}' takes no sha; only action 'merge' pins the head.`,
    );
}

// Rethrown so guardedWrite reports it as a refusal.
function headMovedRefusal(number: number) {
  return (err: unknown): never => {
    if (err instanceof HeadMovedError) {
      throw new Error(
        `merge refused, nothing was merged: the head of pull request ${number} moved and is no longer ${err.expectedSha}. Read the pull request again, review the new head, and merge with its sha. Detail: ${err.message}`,
      );
    }
    throw err;
  };
}

export function defineRepoOperations(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;
  const { guardedRead, guardedWrite } = repoGuards(ctx);

  const REPO_ARG =
    "A label of this namespace, or any repo a namespace maps by owner/name or name. Defaults to the primary repo.";

  ctx.ops.define(
    "list_repo_tree",
    {
      description:
        "List a directory in a namespace's GitHub repo. Omit path for the repo root. Live GitHub, briefly cached.",
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH).optional(),
        ref: bounded(MAX_REF).optional(),
        repo: repoSelector.optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, ref, repo }) =>
      guardedRead("list_repo_tree", namespace, repo, () =>
        listRepoTree(env, namespace, path ?? "", ref, repo),
      ),
  );

  ctx.ops.define(
    "read_repo_file",
    {
      description: `Read a file from a namespace's GitHub repo, decoded to text. Optional ref (branch, tag, or sha). Live GitHub, briefly cached. Pass EITHER path for one file, or paths for up to ${REPO_BATCH_MAX_FILES} in one call; in the batch form each file succeeds or fails on its own, and each is capped at ${REPO_FILE_BUDGET} bytes with truncated:true when it is cut. REFUSES: both path and paths together, neither of them, an empty paths array, more than ${REPO_BATCH_MAX_FILES} paths, and a directory (use capsid_read_repo action tree).`,
      inputSchema: {
        namespace: nsName,
        path: bounded(MAX_PATH).optional(),
        paths: z
          .array(bounded(MAX_PATH))
          .max(REPO_BATCH_MAX_FILES)
          .optional()
          .describe(
            `Up to ${REPO_BATCH_MAX_FILES} paths, read independently. Alternative to path, not combinable with it.`,
          ),
        ref: bounded(MAX_REF).optional(),
        repo: repoSelector.optional().describe(REPO_ARG),
      },
    },
    ({ namespace, path, paths, ref, repo }) =>
      guardedRead("read_repo_file", namespace, repo, () => {
        // EXACTLY ONE OF THE TWO: accepting both and preferring one would make the ignored argument
        // invisible.
        if (path && paths)
          throw new Error("read_repo_file: pass path for one file or paths for several, not both");
        if (!path && !paths)
          throw new Error("read_repo_file: pass path for one file, or paths for several");
        return paths
          ? readRepoFiles(env, namespace, paths, ref, repo)
          : readRepoFile(env, namespace, path as string, ref, repo);
      }),
  );

  ctx.ops.define(
    "search_code",
    {
      description:
        "Case-insensitive substring search across a namespace repo's files, or with all_repos every mapped repo you may read, on each default branch. Scans blobs server-side, so scope large repos with path_prefix. Returns path, line number and the matching line. A scan that stops early sets truncated:true with a note and a next_start to resume from (all_repos lists the repos not reached instead); a truncated result is a partial scan.",
      inputSchema: {
        query: bounded(MAX_QUERY),
        namespace: nsName,
        path_prefix: bounded(MAX_PATH)
          .optional()
          .describe("Only scan files whose path starts with this prefix, e.g. 'app/lib/billing'."),
        ref: bounded(MAX_REF)
          .optional()
          .describe("Branch, tag, or sha to search. Defaults to the default branch."),
        max_results: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Cap on returned matches (default ${DEFAULT_SCAN_RESULTS}, max ${MAX_SCAN_CAP}).`,
          ),
        max_files: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Cap on files fetched and scanned (default ${DEFAULT_SCAN_FILES}, max ${MAX_SCAN_CAP}). Each file costs one GitHub request; resume a wider sweep with start.`,
          ),
        start: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Candidate-file offset to resume a truncated scan; pass the previous result's next_start.",
          ),
        repo: repoSelector.optional().describe(REPO_ARG),
        all_repos: z
          .boolean()
          .optional()
          .describe(
            "Search every mapped repo you may read. Not combinable with repo, ref or start.",
          ),
      },
    },
    ({ query, namespace, path_prefix, ref, max_results, max_files, start, repo, all_repos }) =>
      guardedRead("search_code", namespace, repo, () => {
        if (!all_repos)
          return searchCode(env, namespace, query, {
            pathPrefix: path_prefix,
            ref,
            maxResults: max_results,
            maxFiles: max_files,
            start,
            repoSelector: repo,
          });
        if (repo || ref || start)
          throw new Error("search_code: all_repos takes no repo, ref or start");
        return searchAllRepos(env, query, {
          pathPrefix: path_prefix,
          maxResults: max_results,
          maxFiles: max_files,
          readable: (m) =>
            ctx.scope({ ...toolSurfaceOf("search_code"), namespace: m.namespace, repo: m.repo }) ===
            null,
        });
      }),
  );

  ctx.ops.define(
    "manage_pr",
    {
      description:
        "Merge or close an open pull request in a namespace's repo. action 'merge' uses merge_method (default 'squash') and needs the can_merge flag; with `sha`, it merges only if the head is still that commit and is otherwise refused with nothing merged. action 'close' closes it and needs the can_merge flag. Merge and close delete the head branch and return head_branch and head_branch_deleted, plus head_branch_note when the delete was declined: the default branch and a fork's branch are never deleted, and a failed delete does not fail the merge or close. A merge can trigger a deploy workflow. Needs the write grant.",
      inputSchema: {
        namespace: nsName,
        number: z.number().int().positive(),
        action: z.enum(["merge", "close"]),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
        sha: gitSha
          .optional()
          .describe(
            "For action 'merge': the full head sha you reviewed; the merge is refused if the head moved. Refused for the other actions.",
          ),
        repo: repoSelector.optional().describe(REPO_ARG),
      },
    },
    ({ namespace, number, action, merge_method, sha, repo }) => {
      return guardedWrite(
        "manage_pr",
        namespace,
        null,
        async () => {
          refuseShaOffMerge(action, sha);
          return managePr(
            env,
            namespace,
            number,
            action,
            merge_method ?? "squash",
            repo,
            sha,
          ).catch(headMovedRefusal(number));
        },
        { action, repo },
      );
    },
  );

  ctx.ops.define(
    "ci_status",
    {
      description: `Recent CI workflow runs for a namespace's repo (name, head sha, status, conclusion, timestamps). Optional ref narrows to one branch or head sha; optional run_id returns just that run. For the most recent failed run it also returns the failing jobs and steps and, for a write-grant caller, the failing step's log, up to ${CI_LOG_BUDGET} bytes from its end, with log_region naming the region returned. With run_id, jobs: true returns every job of that run (latest attempt, at most ${CI_JOBS_MAX}) with its steps, conclusions and times, for any run, failed or not; job (a name or id) returns that one job; job with step (a name or number) also returns that step's log, cut to the step by timestamp and capped at ${CI_LOG_BUDGET} bytes from its end. Logs have secrets replaced by [REDACTED:<kind>], counted in log_redactions. A read-only caller gets a note that the log was withheld. REFUSES: a run_id that does not exist on the repo, jobs or job without run_id, step without job, jobs together with job, and a job or step name that is missing or that two entries share.`,
      inputSchema: {
        namespace: nsName,
        repo: repoSelector.optional().describe(REPO_ARG),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many recent runs to return (default 10, max 20)."),
        ref: bounded(MAX_REF)
          .optional()
          .describe(
            "Narrow to one branch or head sha. A hex object name is filtered as a sha, anything else as a branch.",
          ),
        run_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return only this run, by its GitHub run id."),
        jobs: z.boolean().optional().describe("With run_id: every job of the run, with its steps."),
        job: bounded(MAX_CI_NAME)
          .optional()
          .describe("With run_id: one job, by name or numeric id."),
        step: bounded(MAX_CI_NAME)
          .optional()
          .describe("With job: one step, by name or number, and its log for a write-grant caller."),
      },
    },
    ({ namespace, repo, limit, ref, run_id, jobs, job, step }) =>
      // A build log carries whatever the workflow echoed, so a read-only caller gets none; asked of
      // checkScope, and the same answer gates the failed-run tail and a step's log.
      guardedRead("ci_status", namespace, repo, (resolved) =>
        ciStatus(env, namespace, repo, {
          limit,
          logTail:
            ctx.scope({
              ...toolSurfaceOf("ci_status"),
              namespace: resolved.namespace,
              grant: "write",
            }) === null,
          ref,
          runId: run_id,
          jobs,
          job,
          step,
        }),
      ),
  );

  // A ruled exception to the tool surface rule (CLAUDE.md): refs and history stay open to ro: keys;
  // delete_branch needs the write grant, since it destroys refs.

  ctx.ops.define(
    "repo_refs",
    {
      description:
        "What is in flight in a namespace's repo, in one call: branches (name, head sha, last commit date, ahead/behind the default branch, and the open PR number if the branch has one), tags, and open pull requests. Sets truncated:true when any of the three lists hit its 100-item page. Live GitHub, briefly cached.",
      inputSchema: { namespace: nsName, repo: repoSelector.optional().describe(REPO_ARG) },
    },
    ({ namespace, repo }) =>
      guardedRead("repo_refs", namespace, repo, () => repoRefs(env, namespace, repo)),
  );

  ctx.ops.define(
    "repo_history",
    {
      description: `Commits, a comparison, or one commit, chosen by which argument is present: ref for the commits on a ref (default ${REPO_HISTORY_DEFAULT_LIMIT}, max ${REPO_HISTORY_MAX_LIMIT}); base and head together for a comparison (ahead/behind, the commit list, and changed files with status and line counts); sha for one commit (full message, parents, changed files). Patch bodies are omitted unless patch:true, and are then budgeted to ${REPO_PATCH_BUDGET} bytes across the whole response with patch_truncated:true when the budget runs out. Subjects are first lines; read one commit by sha for its whole message. REFUSES: more than one of sha / base+head / ref; base without head or head without base; and none of them.`,
      inputSchema: {
        namespace: nsName,
        ref: bounded(MAX_REF).optional().describe("Commits on this branch, tag or sha."),
        base: bounded(MAX_REF).optional().describe("Comparison base. Requires head."),
        head: bounded(MAX_REF).optional().describe("Comparison head. Requires base."),
        sha: gitSha.optional().describe("One commit, in full."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `How many commits (default ${REPO_HISTORY_DEFAULT_LIMIT}, max ${REPO_HISTORY_MAX_LIMIT}).`,
          ),
        patch: z.boolean().optional().describe("Include patch bodies, budgeted. Off by default."),
        repo: repoSelector.optional().describe(REPO_ARG),
      },
    },
    ({ namespace, ref, base, head, sha, limit, patch, repo }) =>
      guardedRead("repo_history", namespace, repo, () =>
        repoHistory(env, namespace, { ref, base, head, sha, limit, patch }, repo),
      ),
  );

  ctx.ops.define(
    "delete_branch",
    {
      description:
        "Delete a branch in a namespace's GitHub repo. REFUSES, naming the refusal: the default branch, always; a branch with an open pull request; and a branch that does not exist. force:true lifts the open-PR refusal and needs the can_merge flag. Pass merged:true instead of branch to prune every branch whose latest pull request merged and whose tip is the commit that pull request merged from (so work pushed after the merge is kept): it PREVIEWS by default, deleting nothing, and deletes only with confirm:true, at most 40 per call (it reports how many remain); keep:[names] leaves named branches alone. It keeps the default branch, protected branches, release/*, screenshots, results, gh-pages, branches with an open or unmerged pull request and branches with no pull request, and lists why. Give branch or merged, not both; merged does not take force. Needs the write grant; audit-logged with the list.",
      inputSchema: {
        namespace: nsName,
        branch: bounded(MAX_REF)
          .optional()
          .describe("The branch to delete. Omit when merged is true."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Lift the open-PR refusal. Requires the can_merge flag. Does NOT lift the default-branch refusal.",
          ),
        merged: z
          .boolean()
          .optional()
          .describe(
            "Prune the merged branches instead of deleting one: a preview unless confirm is true.",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "With merged: actually delete the branches the preview lists. Without it nothing is deleted.",
          ),
        keep: z
          .array(bounded(MAX_REF))
          .max(100)
          .optional()
          .describe(
            "With merged: branch names to leave alone this call even if they would be pruned.",
          ),
        repo: repoSelector.optional().describe(REPO_ARG),
      },
    },
    ({ namespace, branch, force, merged, confirm, keep, repo }) => {
      if (merged === true) {
        if (branch !== undefined)
          return Promise.resolve(fail("delete_branch takes branch or merged:true, not both."));
        if (force === true)
          return Promise.resolve(
            fail("delete_branch merged does not take force: it never lifts a refusal."),
          );
        return guardedWrite(
          "delete_branch",
          namespace,
          null,
          () => pruneMergedBranches(env, namespace, { confirm, keep }, repo),
          { repo },
        );
      }
      if (confirm !== undefined || keep !== undefined)
        return Promise.resolve(fail("confirm and keep apply only with merged:true."));
      if (branch === undefined)
        return Promise.resolve(
          fail("delete_branch needs a branch, or merged:true to prune the merged ones."),
        );
      return guardedWrite(
        "delete_branch",
        namespace,
        null,
        () => deleteBranch(env, namespace, branch, { force }, repo),
        { force, repo },
      );
    },
  );

  ctx.ops.define(
    "tag_release",
    {
      description:
        'Tag a commit, and with action release also publish its GitHub release, whose notes are the section of the repo\'s CHANGELOG that names the tag (a heading such as "## [1.4.0]" or "## v1.4.0"), read at the tagged commit. The commit is sha, or the head of ref, or the default branch\'s head. A release whose CHANGELOG has no section for the tag is refused before anything is tagged. A tag that exists is refused. Needs the write grant and the can_merge flag, because a tag or a release can start a deploy; audit-logged.',
      inputSchema: {
        namespace: nsName,
        tag: bounded(64).describe("The version to tag, such as v1.4.0 or 1.4.0-rc.1."),
        sha: gitSha.optional().describe("The full commit sha to tag. Not combinable with ref."),
        ref: bounded(MAX_REF)
          .optional()
          .describe("A branch whose head is tagged. Defaults to the default branch."),
        changelog: bounded(MAX_PATH)
          .optional()
          .describe("The CHANGELOG path for a release's notes. Defaults to CHANGELOG.md."),
        publish_release: z
          .boolean()
          .describe("Set by the action: true for release, false for tag."),
        repo: repoSelector.optional().describe(REPO_ARG),
      },
    },
    ({ namespace, tag, sha, ref, changelog, publish_release, repo }) =>
      guardedWrite(
        "tag_release",
        namespace,
        null,
        () =>
          tagRelease(
            env,
            namespace,
            {
              tag,
              sha,
              ref,
              publishRelease: publish_release,
              changelogPath: changelog ?? "CHANGELOG.md",
            },
            repo,
          ),
        {
          repo,
          surface: toolSurfaceOf("tag_release", undefined, publish_release ? "release" : "tag"),
        },
      ),
  );
}
