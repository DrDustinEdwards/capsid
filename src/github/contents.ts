import { base64Decode, base64Encode } from "../encoding";
import { pathProblem } from "../limits";
import type { RepoEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  getFileSha,
  getRefSha,
  ghFetch,
  invalidateRepoReads,
  resolveRepo,
} from "./client";
import { ensureBranch, openPr } from "./refs";
import { SEARCH_TREE_LIMIT } from "./search";

export async function listRepoTree(env: Env, namespace: string, path = "", ref?: string, repoSelector?: string) {
  if (path) assertRepoArg("path", path);
  if (ref) assertRepoArg("ref", ref);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const resp = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
  if (!resp.ok) throw new Error(`list_repo_tree failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as unknown;
  const entries = Array.isArray(data) ? data : [data];
  return {
    repo: `${owner}/${repo}`,
    path: path || "/",
    entries: (entries as Array<{ path: string; type: string; size: number; sha: string }>).map((e) => ({
      path: e.path,
      type: e.type,
      size: e.size,
      sha: e.sha,
    })),
  };
}

// fresh: skip the KV read cache, for a caller that compares two reads (the second must be
// GitHub's answer now, not the first one served back).
export async function readRepoFile(env: Env, namespace: string, path: string, ref?: string, repoSelector?: string, fresh = false) {
  assertRepoArg("path", path);
  if (ref) assertRepoArg("ref", ref);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const api = `/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`;
  const resp = fresh ? await ghFetch(env, owner, repo, api) : await cachedGet(env, owner, repo, api);
  if (!resp.ok) throw new Error(`read_repo_file failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as
    | { type: string; content?: string; encoding?: string; size: number; sha: string }
    | unknown[];
  if (Array.isArray(data)) throw new Error(`${path} is a directory; use capsid_read_repo action tree`);
  if (data.type !== "file") throw new Error(`${path} is not a file (type: ${data.type})`);
  let content: string;
  if (data.encoding === "base64" && data.content) {
    content = base64Decode(data.content);
  } else {
    // Files over 1 MB come back without inline content; fetch the blob by sha.
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    if (!blob.ok) throw new Error(`read_repo_file blob fetch failed (${blob.status})`);
    const blobData = (await blob.json()) as { content: string; encoding: string };
    content = base64Decode(blobData.content);
  }
  return { repo: `${owner}/${repo}`, path, size: data.size, sha: data.sha, content };
}

// Commits the repo tool makes are authored by the owner, not by the App's bot
// (improvement list item 22). The App still commits them, so GitHub shows the owner as
// author and capsid-repo-access[bot] as committer. Without ADMIN_EMAIL, GitHub's
// default (the bot as both) stands.
const COMMIT_AUTHOR_NAME = "Dustin Edwards";

function commitAuthor(env: Pick<Env, "ADMIN_EMAIL">): { author?: { name: string; email: string } } {
  const email = env.ADMIN_EMAIL?.trim();
  return email ? { author: { name: COMMIT_AUTHOR_NAME, email } } : {};
}

async function putFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  allowWorkflowWrite?: boolean
): Promise<{ commitSha: string; fileSha: string }> {
  // The write primitive's own copy of the workflow refusal, so a caller added later
  // inherits it. See workflowWriteRefusal.
  const workflowRefusal = workflowWriteRefusal(path, allowWorkflowWrite);
  if (workflowRefusal) throw new Error(workflowRefusal);
  const sha = await getFileSha(env, owner, repo, path, branch);
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: base64Encode(content),
      branch,
      ...(sha ? { sha } : {}),
      ...commitAuthor(env),
    }),
  });
  if (!resp.ok) throw new Error(`commit failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as { commit: { sha: string }; content: { sha: string } };
  // Cache invalidation is in commitOnBranch, the one site for every verb.
  return { commitSha: data.commit.sha, fileSha: data.content.sha };
}

// The repo this Worker deploys from. A write landing on its default branch is a
// production deploy of the server itself, which is why commitOnBranch refuses direct
// mode, and pr mode aimed at the default branch, against it.
export const SELF_REPO = "DrDustinEdwards/capsid";

// The workflow directory is not ordinary repo content. The App holds Workflows:
// write, and a workflow is code CI executes with that repo's secrets in scope.
//
// Refused unless the caller passes allow_workflow_write, which is audit-logged.
// Checked in two places: commitOnBranch covers both verbs including the delete path
// (which never reaches putFile), and putFile covers the write primitive, so a third
// caller added later inherits the refusal.
const WORKFLOW_DIR = ".github/workflows/";

export function workflowWriteRefusal(path: string, allow: boolean | undefined): string | null {
  if (allow === true) return null;
  // Normalised the way encodePath will see it, so "./.github/workflows/x.yml" and a
  // leading slash cannot slip past a bare startsWith.
  const segments = path.split("/").filter((seg) => seg.length > 0 && seg !== ".");
  const joined = `${segments.join("/")}/`;
  if (!joined.startsWith(WORKFLOW_DIR)) return null;
  return (
    `refuses: ${path} is under ${WORKFLOW_DIR}, and a workflow is code CI executes with this repo's secrets in scope, not ordinary file content. ` +
    `Pass allow_workflow_write: true to write it anyway; the flag is audit-logged.`
  );
}

function branchSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
}

// The steps write_repo_file and delete_repo_file share: resolve the repo, find the
// default branch, cut a work branch in pr mode, mutate, invalidate the read cache,
// and open a PR in pr mode. The invalidation is the hazard: a stale read cache serves
// the pre-write body for up to 60 seconds, and it is only enforced by being written
// once here.
//
// Response shaping stays with each caller. The two responses differ (write carries a
// fileSha, delete does not, and write's pr mode omits it), and folding that in here
// would either change what a caller sees or push per-verb conditionals into the
// shared step.
async function commitOnBranch<R>(
  env: Env,
  namespace: string,
  path: string,
  message: string,
  mode: "pr" | "direct",
  branch: string | undefined,
  repoSelector: string | undefined,
  op: {
    branchPrefix: string;
    fallbackTitle: string;
    prBody: string;
    allowWorkflowWrite?: boolean;
    existingPr?: number;
    mutate: (owner: string, repo: string, target: string) => Promise<R>;
  }
): Promise<{
  base: { repo: string; mode: "pr" | "direct"; branch: string; path: string };
  result: R;
  pr: { number: number; url: string; existing?: true } | null;
  pr_error?: string;
}> {
  assertRepoArg("path", path);
  if (branch) assertRepoArg("branch", branch);
  // `pr` names the open pull request whose head is `branch`, so it means nothing in
  // direct mode or without a branch (a generated branch has no PR yet).
  if (op.existingPr !== undefined && (mode !== "pr" || !branch)) {
    throw new Error(
      `refuses: pr names an existing pull request to commit to, which needs mode "pr" and branch set to that pull request's head branch.`
    );
  }
  // Before any network call, so the refusal cannot be probed by timing. This also
  // covers delete_repo_file, whose mutate never reaches putFile.
  const workflowRefusal = workflowWriteRefusal(path, op.allowWorkflowWrite);
  if (workflowRefusal) throw new Error(workflowRefusal);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  // The server's own default branch cannot be written: CI deploys this Worker on
  // every push to it, so a commit landing there is a production deploy behind a
  // write-grant key.
  //
  // Only the default branch is refused: a direct commit to a work branch is ordinary.
  // Direct mode with no branch always means the default branch, so it is refused without a
  // round trip.
  if (`${owner}/${repo}` === SELF_REPO && mode === "direct" && !branch) {
    throw new Error(
      `refuses: a direct commit with no branch lands on the default branch of this server's own repo (${SELF_REPO}) and redeploys the Worker. Name a work branch, or use mode "pr" and merge through capsid_close_pr action merge.`
    );
  }
  const defaultBranch = await getDefaultBranch(env, owner, repo);
  if (`${owner}/${repo}` === SELF_REPO && branch === defaultBranch) {
    throw new Error(
      `refuses: ${defaultBranch} is the default branch of this server's own repo (${SELF_REPO}), and a commit landing there redeploys the Worker. Use mode "pr" with a work branch and merge through capsid_close_pr action merge, or name a non-default branch.`
    );
  }
  // PR mode never commits to the default branch, on any repo. can_direct_write is
  // required only for mode "direct" (repoWriteFlags), so a pr-mode call naming the
  // default branch as its work branch would commit straight onto it without that
  // flag, and several mapped repos deploy on push. Refused before the branch step and
  // the commit, so nothing lands.
  if (mode === "pr" && branch === defaultBranch) {
    throw new Error(
      `refuses: mode "pr" with branch ${defaultBranch}, which is the default branch of ${owner}/${repo}; the commit would land on it without a pull request. Omit branch, name a work branch, or use mode "direct" (which needs can_direct_write).`
    );
  }
  // A branch an open PR already holds is refused unless the call names that PR, since
  // committing to it changes a PR that may not be the caller's. Uncached, so a PR
  // opened seconds ago is seen, and fail closed: a lookup that errors is not "no open
  // PR".
  let existing: { number: number; url: string } | null = null;
  if (mode === "pr" && branch) {
    const prResp = await ghFetch(
      env,
      owner,
      repo,
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`
    );
    if (!prResp.ok) {
      throw new Error(
        `refuses: could not check open pull requests for ${branch} on ${owner}/${repo} (${prResp.status}), so the write cannot tell whether another pull request holds that branch. Retry.`
      );
    }
    const open = (await prResp.json()) as Array<{ number: number; html_url: string }>;
    const held = open[0];
    if (op.existingPr !== undefined && held?.number !== op.existingPr) {
      throw new Error(
        held
          ? `refuses: pr ${op.existingPr} is not the open pull request on ${branch}; ${branch} on ${owner}/${repo} has open pull request #${held.number} (${held.html_url}).`
          : `refuses: pr ${op.existingPr} is not the open pull request on ${branch}; ${branch} has no open pull request on ${owner}/${repo}. Omit pr to commit and open one.`
      );
    }
    if (held && op.existingPr === undefined) {
      throw new Error(
        `refuses: branch ${branch} on ${owner}/${repo} already has open pull request #${held.number} (${held.html_url}), and this commit would change it. Pass pr: ${held.number} to commit to that pull request, or name a different branch.`
      );
    }
    if (held) existing = { number: held.number, url: held.html_url };
  }
  const target =
    mode === "direct"
      ? branch || defaultBranch
      : branch || `${op.branchPrefix}${branchSlug(path)}-${Date.now().toString(36)}`;

  if (mode === "pr") {
    const headSha = await getRefSha(env, owner, repo, defaultBranch);
    await ensureBranch(env, owner, repo, target, headSha);
  }

  const result = await op.mutate(owner, repo, target);

  // The commit has landed, so every cached read of this repo is potentially stale.
  // Swept here, for both verbs, before the PR is opened.
  await invalidateRepoReads(env, owner, repo);

  const base = { repo: `${owner}/${repo}`, mode, branch: target, path };
  if (mode === "direct") return { base, result, pr: null };
  // The commit landed on a named PR's head, so that PR carries it; a second PR from
  // the same head would be refused by GitHub anyway.
  if (existing) return { base, result, pr: { ...existing, existing: true } };

  const title = message.split("\n")[0] || op.fallbackTitle;
  // The commit has landed, so a failed PR open is reported, not thrown. A throw would
  // reach guardedWrite as a failed call with no audit row, and a caller told "failed"
  // retries into a second commit. The result carries pr: null and pr_error, and
  // guardedWrite audits it like any other landed write.
  //
  // The resolved repo is passed so the PR lands on the repo the file was committed
  // to, not the namespace default.
  try {
    const pr = await openPr(env, namespace, title, target, defaultBranch, op.prBody, `${owner}/${repo}`);
    return { base, result, pr: { number: pr.number, url: pr.url } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      base,
      result,
      pr: null,
      pr_error:
        `THE COMMIT LANDED on ${target} of ${owner}/${repo}, but the pull request could not be opened: ${reason}. ` +
        `Do not retry this write; open the pull request with capsid_open_pr action open (head ${target}).`,
    };
  }
}

export async function writeRepoFile(
  env: Env,
  namespace: string,
  path: string,
  content: string,
  message: string,
  mode: "pr" | "direct" = "pr",
  branch?: string,
  repoSelector?: string,
  allowWorkflowWrite?: boolean,
  existingPr?: number
) {
  const { base, result, pr, pr_error } = await commitOnBranch(env, namespace, path, message, mode, branch, repoSelector, {
    branchPrefix: "capsid/",
    fallbackTitle: `Update ${path}`,
    prBody: `Automated change to \`${path}\` via Capsid.`,
    allowWorkflowWrite,
    existingPr,
    mutate: (owner, repo, target) => putFile(env, owner, repo, path, content, message, target, allowWorkflowWrite),
  });
  // Returned so it lands in audit_log via guardedWrite, which files the whole result,
  // and a workflow authored through this tool is greppable afterwards.
  const flag = allowWorkflowWrite === true ? { allow_workflow_write: true } : {};
  // direct carries the file sha as well as the commit sha; pr mode does not. Kept,
  // because tidying it would change what a caller receives.
  if (pr_error) return { ...base, commitSha: result.commitSha, pr: null, pr_error, ...flag };
  if (!pr) return { ...base, ...result, ...flag };
  return { ...base, commitSha: result.commitSha, pr, ...flag };
}

// Delete a file from a namespace's repo. PR mode (default) commits the deletion
// to a work branch and opens a PR; direct mode deletes on the default branch.
export async function deleteRepoFile(
  env: Env,
  namespace: string,
  path: string,
  message: string,
  mode: "pr" | "direct" = "pr",
  branch?: string,
  repoSelector?: string,
  allowWorkflowWrite?: boolean,
  existingPr?: number
) {
  const { base, result, pr, pr_error } = await commitOnBranch(env, namespace, path, message, mode, branch, repoSelector, {
    branchPrefix: "capsid/rm-",
    fallbackTitle: `Delete ${path}`,
    prBody: `Delete \`${path}\` via Capsid.`,
    allowWorkflowWrite,
    existingPr,
    mutate: async (owner, repo, target) => {
      // GitHub's contents DELETE needs the CURRENT file sha, so a missing file is an
      // error rather than a no-op. Read on the target branch, which in pr mode is
      // the work branch just cut from the default.
      const sha = await getFileSha(env, owner, repo, path, target);
      if (!sha) throw new Error(`delete_repo_file: ${path} does not exist on ${owner}/${repo}@${target}`);
      const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sha, branch: target, ...commitAuthor(env) }),
      });
      if (!resp.ok) throw new Error(`delete failed (${resp.status}): ${await resp.text()}`);
      const data = (await resp.json()) as { commit: { sha: string } };
      return { commitSha: data.commit.sha };
    },
  });
  const flag = allowWorkflowWrite === true ? { allow_workflow_write: true } : {};
  if (pr_error) return { ...base, commitSha: result.commitSha, pr: null, pr_error, ...flag };
  if (!pr) return { ...base, commitSha: result.commitSha, ...flag };
  return { ...base, commitSha: result.commitSha, pr, ...flag };
}

export const REPO_BATCH_MAX_FILES = 20;
export const REPO_FILE_BUDGET = 200 * 1024;

/** Read up to REPO_BATCH_MAX_FILES files, each independently. One missing path does
 *  not fail the batch: a batch is triage, and a triage call that throws because one
 *  of twenty paths moved has to be retried by bisection.
 *
 *  The per-file budget applies here and not to the single-path read, so an existing
 *  readRepoFile call never starts truncating silently. */
export async function readRepoFiles(env: Env, namespace: string, paths: string[], ref?: string, repoSelector?: string) {
  if (paths.length === 0) throw new Error("read_repo_file: paths was empty");
  if (paths.length > REPO_BATCH_MAX_FILES) {
    throw new Error(`read_repo_file: ${paths.length} paths exceeds the batch maximum of ${REPO_BATCH_MAX_FILES}`);
  }
  const { full } = await resolveRepo(env, namespace, repoSelector);
  const files = await Promise.all(
    paths.map(async (path) => {
      const problem = pathProblem(path);
      if (problem) return { path, error: problem };
      try {
        const one = await readRepoFile(env, namespace, path, ref, repoSelector);
        const truncated = one.content.length > REPO_FILE_BUDGET;
        return {
          path,
          size: one.size,
          sha: one.sha,
          truncated,
          content: truncated ? one.content.slice(0, REPO_FILE_BUDGET) : one.content,
        };
      } catch (err) {
        return { path, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  const failed = files.filter((f) => "error" in f).length;
  return {
    repo: full,
    requested: paths.length,
    ok: files.length - failed,
    failed,
    bytes: files.reduce((n, f) => n + ("content" in f && f.content ? f.content.length : 0), 0),
    files,
  };
}

// Every blob path on the default branch, in one call, for the truth report's
// doc-vs-code drift check, which asks a set-membership question about a few hundred
// paths. It reuses searchCode's tree fetch and size refusal: a recursive tree on a
// large repo is one response, and GitHub truncates it silently past a limit.
//
// Returns null rather than throwing when the tree cannot be read or is too large, so
// the caller reports the check as unrun; an empty set would report every cited path
// as drift.
export async function repoBlobPaths(env: Env, namespace: string, repoSelector?: string): Promise<Set<string> | null> {
  try {
    const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
    const ref = await getDefaultBranch(env, owner, repo);
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (!resp.ok) return null;
    const tree = (await resp.json()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
    if (!Array.isArray(tree.tree) || tree.truncated || tree.tree.length > SEARCH_TREE_LIMIT) return null;
    return new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));
  } catch {
    return null;
  }
}
