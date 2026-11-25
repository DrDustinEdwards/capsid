import type { RepoEnv as Env } from "../env";
import { DEFAULT_SCAN_RESULTS, MAX_SCAN_CAP, DEFAULT_SCAN_FILES } from "../limits";
import { ghFetch, resolveRepo, getDefaultBranch } from "./client";
import { fromBase64Text } from "@dustinedwards/site-runtime/encoding";

// search_code walks the tree: GET /search/code returns 200 with total_count 0 for private repos
// under an App installation token.
const SEARCH_EXCLUDE_DIRS = ["node_modules/", ".git/", "dist/"];
const SEARCH_EXCLUDE_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);
const SEARCH_EXCLUDE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "mov",
  "webm",
  "mp3",
  "wav",
  "wasm",
  "bin",
  "exe",
  "dll",
  "so",
  "dylib",
  "class",
  "jar",
  "pyc",
  "lockb",
]);
const SEARCH_BLOB_LIMIT = 200 * 1024; // skip blobs over 200KB
export const SEARCH_TREE_LIMIT = 5000; // refuse to scan a tree bigger than this whole

type TreeEntry = { path: string; type: string; sha: string; size?: number };

async function searchCandidates(
  env: Env,
  target: { owner: string; repo: string; full: string },
  ref: string,
  pathPrefix: string,
): Promise<TreeEntry[]> {
  const { owner, repo, full } = target;
  const treeResp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  if (!treeResp.ok)
    throw new Error(`search_code tree fetch failed (${treeResp.status}): ${await treeResp.text()}`);
  const tree = (await treeResp.json()) as {
    tree: TreeEntry[];
    truncated: boolean;
  };
  if (tree.truncated || tree.tree.length > SEARCH_TREE_LIMIT) {
    throw new Error(
      `search_code: ${full}@${ref} tree is too large to scan whole (${tree.tree.length} entries, truncated=${tree.truncated}). Narrow it with path_prefix.`,
    );
  }

  return tree.tree.filter((e) => {
    if (e.type !== "blob") return false;
    if (pathPrefix && !e.path.startsWith(pathPrefix)) return false;
    if (SEARCH_EXCLUDE_DIRS.some((d) => e.path.startsWith(d) || e.path.includes(`/${d}`)))
      return false;
    const base = e.path.split("/").pop() ?? e.path;
    if (SEARCH_EXCLUDE_FILES.has(base)) return false;
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
    if (SEARCH_EXCLUDE_EXTS.has(ext)) return false;
    if (typeof e.size === "number" && e.size > SEARCH_BLOB_LIMIT) return false;
    return true;
  });
}

interface BlobScan {
  items: Array<{ path: string; line: number; text: string }>;
  // Blobs that returned a survivable error, so a zero-result scan cannot pass for one that read
  // everything.
  unreadable: string[];
  filesScanned: number;
  index: number;
  stoppedAtFileCap: boolean;
}

async function scanBlobs(
  env: Env,
  target: { owner: string; repo: string },
  candidates: TreeEntry[],
  query: string,
  limits: { start: number; maxFiles: number; maxResults: number },
): Promise<BlobScan> {
  const { owner, repo } = target;
  const { start, maxFiles, maxResults } = limits;
  const needle = query.toLowerCase();
  const items: BlobScan["items"] = [];
  const unreadable: string[] = [];
  let filesScanned = 0;
  let index = start;
  let stoppedAtFileCap = false;
  for (; index < candidates.length; index++) {
    if (filesScanned >= maxFiles) {
      stoppedAtFileCap = true;
      break;
    }
    filesScanned++;
    const c = candidates[index];
    const blob = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/blobs/${c.sha}`);
    if (!blob.ok) {
      // A blob that could not be read is not a blob with no match: 401, 403 and 429 abort the scan
      // (the limit fails every later fetch); other errors are counted and reported.
      if (blob.status === 401 || blob.status === 403 || blob.status === 429) {
        throw new Error(
          `search_code aborted at ${filesScanned} of ${candidates.length} candidate files: GitHub returned ${blob.status} fetching ${c.path}. ` +
            `This is NOT an empty result. The scan could not read the repository, so no conclusion about whether "${query}" is present is available. ` +
            (blob.status === 429 || blob.status === 403
              ? "The App installation's rate limit is the usual cause; a full-tree scan costs one request per candidate file. Wait for the window to reset, narrow with path_prefix, or verify against a local checkout."
              : "Check the App installation's permissions for this repo."),
        );
      }
      unreadable.push(c.path);
      continue;
    }
    const blobData = (await blob.json()) as { content?: string; encoding?: string };
    if (blobData.encoding !== "base64" || !blobData.content) continue;
    let text: string;
    try {
      text = fromBase64Text(blobData.content);
    } catch {
      continue; // binary that slipped past the extension filter
    }
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
  return { items, unreadable, filesScanned, index, stoppedAtFileCap };
}

export async function searchCode(
  env: Env,
  namespace: string | undefined,
  query: string,
  opts: {
    pathPrefix?: string;
    ref?: string;
    repoSelector?: string;
    maxResults?: number;
    maxFiles?: number;
    start?: number;
  } = {},
) {
  if (!namespace) {
    throw new Error(
      "search_code needs a namespace: it walks one repo's tree. Pass namespace (and optional repo).",
    );
  }
  const target = await resolveRepo(env, namespace, opts.repoSelector);
  const ref = opts.ref || (await getDefaultBranch(env, target.owner, target.repo));
  // Clamped, not refused: each scanned file costs one blob fetch against the App's hourly quota,
  // and the result carries truncation and next_start.
  const maxResults = Math.min(
    opts.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_SCAN_RESULTS,
    MAX_SCAN_CAP,
  );
  const maxFiles = Math.min(
    opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_SCAN_FILES,
    MAX_SCAN_CAP,
  );
  const start = opts.start && opts.start > 0 ? Math.floor(opts.start) : 0;
  const pathPrefix = (opts.pathPrefix ?? "").replace(/^\/+/, "");

  const candidates = await searchCandidates(env, target, ref, pathPrefix);
  const { items, unreadable, filesScanned, index, stoppedAtFileCap } = await scanBlobs(
    env,
    target,
    candidates,
    query,
    {
      start,
      maxFiles,
      maxResults,
    },
  );

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
    repo: target.full,
    ref,
    query,
    candidates: candidates.length,
    start,
    files_scanned: filesScanned,
    total_results: items.length,
    truncated: false,
    items,
  };

  // Unreadable files are reported: "0 results, 12 unreadable" differs from "0 results".
  if (unreadable.length > 0) {
    result.unreadable_files = unreadable.length;
    result.unreadable_sample = unreadable.slice(0, 10);
  }

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
