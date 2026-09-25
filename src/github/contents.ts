import { base64Decode, base64Encode } from "../encoding";
import { DEFAULT_SCAN_FILES, DEFAULT_SCAN_RESULTS, MAX_SCAN_CAP, pathProblem } from "../limits";
import type { AttemptEnv as Env } from "../env";
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

export async function readRepoFile(env: Env, namespace: string, path: string, ref?: string, repoSelector?: string) {
  assertRepoArg("path", path);
  if (ref) assertRepoArg("ref", ref);
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const resp = await cachedGet(env, owner, repo, `/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`);
  if (!resp.ok) throw new Error(`read_repo_file failed (${resp.status}): ${await resp.text()}`);
  const data = (await resp.json()) as
    | { type: string; content?: string; encoding?: string; size: number; sha: string }
    | unknown[];
  if (Array.isArray(data)) throw new Error(`${path} is a directory; use list_repo_tree`);
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

// search_code is a server-side tree walk, not the REST search API: GET /search/code
// returns 200 with zero results for private repos under an App installation token.
const SEARCH_EXCLUDE_DIRS = ["node_modules/", ".git/", "dist/"];
const SEARCH_EXCLUDE_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
const SEARCH_EXCLUDE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "tar", "bz2",
  "woff", "woff2", "ttf", "otf", "eot", "mp4", "mov", "webm", "mp3", "wav", "wasm",
  "bin", "exe", "dll", "so", "dylib", "class", "jar", "pyc", "lockb",
]);
const SEARCH_BLOB_LIMIT = 200 * 1024; // skip blobs over 200KB
const SEARCH_TREE_LIMIT = 5000; // refuse to scan a tree bigger than this whole

export async function searchCode(
  env: Env,
  namespace: string | undefined,
  query: string,
  opts: { pathPrefix?: string; ref?: string; repoSelector?: string; maxResults?: number; maxFiles?: number; start?: number } = {}
) {
  if (!namespace) {
    throw new Error("search_code needs a namespace: it walks one repo's tree. Pass namespace (and optional repo).");
  }
  const { owner, repo, full } = await resolveRepo(env, namespace, opts.repoSelector);
  const ref = opts.ref || (await getDefaultBranch(env, owner, repo));
  // Capped server-side: each scanned file costs one request against the App
  // installation's hourly quota. Over the cap it clamps rather than refusing, because
  // the result reports truncation and carries a next_start.
  const maxResults = Math.min(opts.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_SCAN_RESULTS, MAX_SCAN_CAP);
  const maxFiles = Math.min(opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_SCAN_FILES, MAX_SCAN_CAP);
  const start = opts.start && opts.start > 0 ? Math.floor(opts.start) : 0;
  const pathPrefix = (opts.pathPrefix ?? "").replace(/^\/+/, "");

  // GitHub resolves a branch, tag, or sha for the tree sha here. recursive=1
  // returns the whole tree in one call.
  const treeResp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!treeResp.ok) throw new Error(`search_code tree fetch failed (${treeResp.status}): ${await treeResp.text()}`);
  const tree = (await treeResp.json()) as {
    tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    truncated: boolean;
  };
  if (tree.truncated || tree.tree.length > SEARCH_TREE_LIMIT) {
    throw new Error(
      `search_code: ${full}@${ref} tree is too large to scan whole (${tree.tree.length} entries, truncated=${tree.truncated}). Narrow it with path_prefix.`
    );
  }

  const candidates = tree.tree.filter((e) => {
    if (e.type !== "blob") return false;
    if (pathPrefix && !e.path.startsWith(pathPrefix)) return false;
    if (SEARCH_EXCLUDE_DIRS.some((d) => e.path.startsWith(d) || e.path.includes(`/${d}`))) return false;
    const base = e.path.split("/").pop() ?? e.path;
    if (SEARCH_EXCLUDE_FILES.has(base)) return false;
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
    if (SEARCH_EXCLUDE_EXTS.has(ext)) return false;
    if (typeof e.size === "number" && e.size > SEARCH_BLOB_LIMIT) return false;
    return true;
  });

  const needle = query.toLowerCase();
  const items: Array<{ path: string; line: number; text: string }> = [];
  // Blobs that returned a survivable error. Reported so a zero-result scan cannot
  // pass for one that read everything it counted.
  const unreadable: string[] = [];
  let filesScanned = 0;
  let index = start;
  let stoppedAtFileCap = false;
  for (; index < candidates.length; index++) {
    if (filesScanned >= maxFiles) {
      // Cap reached before candidates[index] was scanned, so it is the first
      // unsearched file and a caller can resume from here.
      stoppedAtFileCap = true;
      break;
    }
    filesScanned++;
    const c = candidates[index];
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${c.sha}`);
    if (!blob.ok) {
      // A blob this scan could not read is not a blob with no match. Quota and auth
      // failures (401, 403, 429) abort the whole scan, since every later fetch fails
      // the same way. Anything else (a 404 on a raced deletion, a 5xx on one blob) is
      // counted and reported.
      if (blob.status === 401 || blob.status === 403 || blob.status === 429) {
        throw new Error(
          `search_code aborted at ${filesScanned} of ${candidates.length} candidate files: GitHub returned ${blob.status} fetching ${c.path}. ` +
            `This is NOT an empty result. The scan could not read the repository, so no conclusion about whether "${query}" is present is available. ` +
            (blob.status === 429 || blob.status === 403
              ? "The App installation's rate limit is the usual cause; a full-tree scan costs one request per candidate file. Wait for the window to reset, narrow with path_prefix, or verify against a local checkout."
              : "Check the App installation's permissions for this repo.")
        );
      }
      unreadable.push(c.path);
      continue;
    }
    const blobData = (await blob.json()) as { content?: string; encoding?: string };
    if (blobData.encoding !== "base64" || !blobData.content) continue;
    let text: string;
    try {
      text = base64Decode(blobData.content);
    } catch {
      continue; // binary that slipped past the extension filter
    }
    // Match line by line, then let text and its lines fall out of scope, so only one
    // blob is held in memory at a time.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && items.length < maxResults; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        items.push({ path: c.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    if (items.length >= maxResults) {
      index++;
      break;
    }
  }

  const remaining = candidates.length - index;
  const result: {
    repo: string;
    ref: string;
    query: string;
    candidates: number;
    start: number;
    files_scanned: number;
    total_results: number;
    truncated: boolean;
    next_start?: number;
    note?: string;
    unreadable_files?: number;
    unreadable_sample?: string[];
    items: typeof items;
  } = {
    repo: full,
    ref,
    query,
    candidates: candidates.length,
    start,
    files_scanned: filesScanned,
    total_results: items.length,
    truncated: false,
    items,
  };

  // Surfaced rather than swallowed: "0 results over 200 files, 12 of which were
  // unreadable" is a different claim from "0 results over 200 files".
  if (unreadable.length > 0) {
    result.unreadable_files = unreadable.length;
    result.unreadable_sample = unreadable.slice(0, 10);
  }

  // A boolean alone is not actionable: say WHY it stopped and what to do next.
  if (stoppedAtFileCap && remaining > 0) {
    result.truncated = true;
    result.next_start = index;
    result.note =
      `Stopped at the max_files cap (${maxFiles}): ${remaining} of ${candidates.length} candidate files were not searched, so matches past this point are NOT included. ` +
      `Narrow with path_prefix (a subdirectory), or pass start=${index} to continue this scan from where it left off.`;
  } else if (items.length >= maxResults && remaining > 0) {
    result.truncated = true;
    result.note =
      `Returned the first ${maxResults} matches (max_results cap) with files still unsearched; more matches may exist. ` +
      `Raise max_results, or narrow with path_prefix.`;
  }

  return result;
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

// A workflow is code CI executes with that repo's secrets in scope, and the App can
// write it. Refused unless the caller passes allow_workflow_write, which is
// audit-logged. Checked in commitOnBranch (both verbs, including delete) and in
// putFile (so a later caller of the write primitive inherits it).
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
// default branch, cut a work branch in pr mode, mutate, invalidate the read cache
// (a stale cache serves the pre-write body for up to 60 seconds), and open a PR in pr
// mode. Response shaping stays with each caller, because the two responses differ.
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
  // every push to it. Only the default branch is refused, because the improve loop
  // pushes attempts to work branches in direct mode. Direct mode with no branch always
  // means the default branch, so it is refused without a round trip.
  if (`${owner}/${repo}` === SELF_REPO && mode === "direct" && !branch) {
    throw new Error(
      `refuses: a direct commit with no branch lands on the default branch of this server's own repo (${SELF_REPO}) and redeploys the Worker. Name a work branch, or use mode "pr" and merge through manage_pr.`
    );
  }
  const defaultBranch = await getDefaultBranch(env, owner, repo);
  if (`${owner}/${repo}` === SELF_REPO && branch === defaultBranch) {
    throw new Error(
      `refuses: ${defaultBranch} is the default branch of this server's own repo (${SELF_REPO}), and a commit landing there redeploys the Worker. Use mode "pr" with a work branch and merge through manage_pr, or name a non-default branch.`
    );
  }
  // PR mode never commits to the default branch, on any repo: can_direct_write is
  // required only for mode "direct", and several mapped repos deploy on push.
  if (mode === "pr" && branch === defaultBranch) {
    throw new Error(
      `refuses: mode "pr" with branch ${defaultBranch}, which is the default branch of ${owner}/${repo}; the commit would land on it without a pull request. Omit branch, name a work branch, or use mode "direct" (which needs can_direct_write).`
    );
  }
  // A branch an open PR already holds is refused unless the call names that PR, since
  // committing to it changes a PR that may not be the caller's. Uncached, and fail
  // closed: a lookup that errors is not "no open PR".
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
  // The commit has landed, so a failed PR open is reported, not thrown: a throw would
  // leave no audit row and a caller told "failed" retries into a second commit.
  // The resolved repo is passed so the PR lands where the file was committed.
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
        `Do not retry this write; open the pull request with open_pr (head ${target}).`,
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
  // Returned so it lands in audit_log via guardedWrite.
  const flag = allowWorkflowWrite === true ? { allow_workflow_write: true } : {};
  // direct carries the file sha as well as the commit sha; pr mode does not.
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
        body: JSON.stringify({ message, sha, branch: target }),
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

/** Read up to REPO_BATCH_MAX_FILES files, each independently: one missing path does
 *  not fail the batch. The per-file budget applies here and not to the single-path
 *  read, so readRepoFile never truncates silently. */
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
// doc-vs-code drift check. Returns null when the tree cannot be read or is too large
// (GitHub truncates it silently), so the caller reports the check as unrun; an empty
// set would report every cited path as drift.
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
