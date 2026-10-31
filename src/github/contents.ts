import { pathProblem } from "../limits";
import type { RepoEnv as Env } from "../env";
import {
  assertRepoArg,
  cachedGet,
  encodePath,
  getDefaultBranch,
  ghFetch,
  resolveRepo,
} from "./client";
import { SEARCH_TREE_LIMIT } from "./search";
import { fromBase64 } from "@dustinedwards/site-runtime/encoding";

const decodeBase64 = (text: string): string => new TextDecoder().decode(fromBase64(text));

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
    content = decodeBase64(data.content);
  } else {
    // Files over 1 MB come back without inline content; fetch the blob by sha.
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${data.sha}`);
    if (!blob.ok) throw new Error(`read_repo_file blob fetch failed (${blob.status})`);
    const blobData = (await blob.json()) as { content: string; encoding: string };
    content = decodeBase64(blobData.content);
  }
  return { repo: `${owner}/${repo}`, path, size: data.size, sha: data.sha, content };
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
