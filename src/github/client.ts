// Short-lived installation tokens (RS256 JWT, site-runtime/jwt) cached in APP_KV for ~55 minutes.
// No PAT, no clone.

import { repoPathProblem } from "../limits";
// RepoEnv, not Env: this module must not be able to name the credentials it omits.
import type { RepoEnv as Env } from "../env";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { githubAppJwt } from "@dustinedwards/site-runtime/jwt";
import { GITHUB_API, githubHeaders, installationToken } from "@dustinedwards/site-runtime/github";
import { callSignal } from "../call-signal";

const GH = GITHUB_API;
const GH_HEADERS = githubHeaders(null, "capsid");

const TOKEN_TTL_SECONDS = 3300; // installation tokens live 60 min; refresh a little early
const INSTALL_TTL_SECONDS = 86400; // installation id is stable
const READ_CACHE_TTL_SECONDS = 60; // brief cache for read tools
// Every call is bounded, so a hung connection fails instead of holding the request; a caller's own
// signal wins.
const GH_TIMEOUT_MS = 30_000;

const installKey = (owner: string) => `gh:install:v2:${owner}`;
const tokenKey = (owner: string, repo: string) => `gh:token:v3:${owner}/${repo}`;
const readKey = (path: string) => `gh:get:${path}`;
// The trailing slash matters: without it, owner/r would also match owner/repo2.
const readPrefix = (owner: string, repo: string) => `gh:get:/repos/${owner}/${repo}/`;

export interface RepoRef {
  owner: string;
  repo: string;
  full: string;
}

async function createAppJwt(env: Env): Promise<string> {
  const { appId, privateKey } = appCredentials(env);
  return githubAppJwt(appId, privateKey);
}

async function appFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const jwt = await createAppJwt(env);
  return fetch(`${GH}${path}`, {
    ...init,
    headers: {
      ...GH_HEADERS,
      ...(init?.headers as Record<string, string>),
      Authorization: `Bearer ${jwt}`,
    },
    signal: init?.signal ?? callSignal(GH_TIMEOUT_MS),
  });
}

function appCredentials(env: Env): { appId: string; privateKey: string } {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      "GitHub App not configured: set GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY",
    );
  }
  return { appId: env.GITHUB_APP_CLIENT_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
}

async function getInstallationToken(env: Env, owner: string, repo: string): Promise<string> {
  const cacheKey = tokenKey(owner, repo);
  const cached = await env.APP_KV.get(cacheKey);
  if (cached) return cached;
  const knownId = await env.APP_KV.get(installKey(owner));
  // Scoped to the one repo asked about. A token minted with no `repositories` covers every
  // repo the installation does, and that token would then sit in APP_KV.
  const minted = await installationToken({
    ...appCredentials(env),
    userAgent: "capsid",
    owner,
    repo,
    installationId: knownId ?? undefined,
    repositories: [repo],
    fetcher: (input, init) =>
      fetch(input, { ...init, signal: init?.signal ?? callSignal(GH_TIMEOUT_MS) }),
  });
  if (!knownId)
    await env.APP_KV.put(installKey(owner), minted.installationId, {
      expirationTtl: INSTALL_TTL_SECONDS,
    });
  await env.APP_KV.put(cacheKey, minted.token, { expirationTtl: TOKEN_TTL_SECONDS });
  return minted.token;
}

// Minted per call, metadata:read only, never stored or logged: the only unscoped token in the
// Worker.
export interface InstalledRepo {
  full_name: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
}

const LIST_PER_PAGE = 100;
const LIST_MAX_PAGES = 10;

export async function listInstalledRepos(
  env: Env,
): Promise<{ repos: InstalledRepo[]; installations: number }> {
  const installations: number[] = [];
  for (let page = 1; ; page++) {
    if (page > LIST_MAX_PAGES)
      throw new Error(`the App has more than ${LIST_MAX_PAGES * LIST_PER_PAGE} installations`);
    const resp = await appFetch(env, `/app/installations?per_page=${LIST_PER_PAGE}&page=${page}`);
    if (!resp.ok) throw new Error(`could not list the App's installations (${resp.status})`);
    const rows = (await resp.json()) as Array<{ id: number }>;
    installations.push(...rows.map((r) => r.id));
    if (rows.length < LIST_PER_PAGE) break;
  }

  const repos: InstalledRepo[] = [];
  for (const id of installations) {
    const { token } = await installationToken({
      ...appCredentials(env),
      userAgent: "capsid",
      installationId: id,
      permissions: { metadata: "read" },
      fetcher: (input, init) => fetch(input, { ...init, signal: callSignal(GH_TIMEOUT_MS) }),
    });
    let total = Infinity;
    const seen: InstalledRepo[] = [];
    for (let page = 1; seen.length < total; page++) {
      if (page > LIST_MAX_PAGES)
        throw new Error(
          `installation ${id} lists more than ${LIST_MAX_PAGES * LIST_PER_PAGE} repos`,
        );
      const resp = await fetch(
        `${GH}/installation/repositories?per_page=${LIST_PER_PAGE}&page=${page}`,
        {
          headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` },
          signal: callSignal(GH_TIMEOUT_MS),
        },
      );
      if (!resp.ok)
        throw new Error(`could not list the repos of installation ${id} (${resp.status})`);
      const body = (await resp.json()) as {
        total_count: number;
        repositories: Array<{
          full_name: string;
          private: boolean;
          archived?: boolean;
          pushed_at?: string | null;
        }>;
      };
      total = body.total_count;
      if (body.repositories.length === 0) break;
      for (const r of body.repositories) {
        seen.push({
          full_name: r.full_name,
          private: r.private,
          archived: r.archived === true,
          pushed_at: r.pushed_at ?? null,
        });
      }
    }
    if (seen.length < total)
      throw new Error(`installation ${id} listed ${seen.length} of ${total} repos`);
    repos.push(...seen);
  }
  return { repos, installations: installations.length };
}

// One installation covers every repo under a single owner, but each minted token is
// scoped to one repo, so the token cache is per owner+repo to match.

// The built URL must not escape /repos/<owner>/<repo>/: a "../.." in a path or branch would
// normalize out once fetch() parses it, so this checks the normalized URL.
function repoApiUrl(owner: string, repo: string, path: string): string {
  const url = `${GH}${path}`;
  const base = `/repos/${owner}/${repo}`;
  const { pathname } = new URL(url);
  if (pathname !== base && !pathname.startsWith(`${base}/`)) {
    throw new Error(`refusing GitHub request that escapes ${base}: it resolves to ${pathname}`);
  }
  return url;
}

export async function ghFetch(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = repoApiUrl(owner, repo, path);
  const call = (token: string) =>
    fetch(url, {
      ...init,
      headers: {
        ...GH_HEADERS,
        ...(init?.headers as Record<string, string>),
        Authorization: `Bearer ${token}`,
      },
      signal: init?.signal ?? callSignal(GH_TIMEOUT_MS),
    });
  let resp = await call(await getInstallationToken(env, owner, repo));
  if (resp.status === 401) {
    await env.APP_KV.delete(tokenKey(owner, repo));
    resp = await call(await getInstallationToken(env, owner, repo));
  }
  return resp;
}

export async function cachedGet(
  env: Env,
  owner: string,
  repo: string,
  path: string,
): Promise<Response> {
  // Assert the URL is in-bounds before it is ever used as a cache key, so a
  // traversal path cannot be stored under a key the invalidator will not find.
  repoApiUrl(owner, repo, path);
  const cacheKey = readKey(path);
  const cached = (await env.APP_KV.get(cacheKey, "json")) as {
    status: number;
    body: string;
  } | null;
  if (cached) return new Response(cached.body, { status: cached.status });
  const resp = await ghFetch(env, owner, repo, path);
  const body = await resp.text();
  if (resp.ok) {
    await env.APP_KV.put(cacheKey, JSON.stringify({ status: resp.status, body }), {
      expirationTtl: READ_CACHE_TTL_SECONDS,
    });
  }
  return new Response(body, { status: resp.status });
}

// Swept by repo prefix, not computed key: a key-precise sweep must reproduce every spelling of
// every entry, and one miss is a stale read.
export async function invalidateRepoReads(env: Env, owner: string, repo: string): Promise<number> {
  const prefix = readPrefix(owner, repo);
  let cursor: string | undefined;
  let deleted = 0;
  try {
    do {
      const page = await env.APP_KV.list({ prefix, cursor });
      await Promise.all(page.keys.map((key) => env.APP_KV.delete(key.name)));
      deleted += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch (err) {
    // The commit already landed: failing the call over a cache sweep would misreport the write; the
    // stale window is bounded by the 60 second TTL.
    logEvent(
      "GH_CACHE_INVALIDATION_FAILED",
      {
        message: `GH_CACHE_INVALIDATION_FAILED ${owner}/${repo}: ${errorMessage(err)}`,
      },
      { level: "error" },
    );
  }
  return deleted;
}

// Strict "owner/name": a looser shape would admit "../other" and make the authorization boundary
// traversable.
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// "." and ".." satisfy the charset but walk a URL out of /repos/<owner>/<repo>/.
export function repoTokenOk(repoFull: string): boolean {
  if (!REPO_SHAPE.test(repoFull)) return false;
  const [owner, name] = repoFull.split("/");
  return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

export interface RepoEntry {
  repo: string;
  label: string;
}

// Shared by register_namespace and update_namespace; does not enforce a single primary
// (update_namespace adds that).
export function parseReposList(reposJson: string): { list: RepoEntry[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reposJson);
  } catch (err) {
    return { error: `invalid repos JSON: ${errorMessage(err)}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "repos must be a non-empty JSON array of { repo, label } entries" };
  }
  const list: RepoEntry[] = [];
  for (const r of parsed) {
    if (!r || typeof r.repo !== "string" || !repoTokenOk(r.repo)) {
      return {
        error: `each repos entry needs a "repo" of the form owner/name (got ${JSON.stringify(r)})`,
      };
    }
    list.push({
      repo: r.repo,
      label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "primary",
    });
  }
  return { list };
}

export function parseMappedRepos(
  reposJson: string | null,
): { list: RepoEntry[] } | { error: string } {
  return reposJson && reposJson.trim() !== "[]" ? parseReposList(reposJson) : { list: [] };
}

export function requireSinglePrimary(list: RepoEntry[]): string | null {
  const primaries = list.filter((r) => r.label === "primary").length;
  return primaries === 1
    ? null
    : `repos must have exactly one entry labeled "primary" (found ${primaries})`;
}

// The mapping is the authorization boundary: an unknown selector is rejected, never falls through
// to an arbitrary repo.
export async function resolveRepo(
  env: Env,
  namespace: string,
  selector?: string,
): Promise<RepoRef> {
  const row = await env.DB.prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
    .bind(namespace)
    .first<{ repos: string }>();
  if (!row) throw new Error(`unknown namespace: ${namespace}`);
  // Fails closed: a corrupt repos column is reported as corrupt, not as an unconfigured namespace,
  // which invites overwriting it.
  let list: Array<{ repo: string; label?: string }>;
  try {
    list = JSON.parse(row.repos || "[]");
  } catch (err) {
    throw new Error(
      `namespace ${namespace} has a CORRUPT repos mapping: the stored value is not valid JSON (${errorMessage(err)}). Nothing was resolved. Repair it with capsid_admin_manage_namespaces action update.`,
    );
  }
  if (!Array.isArray(list)) {
    throw new Error(
      `namespace ${namespace} has a CORRUPT repos mapping: expected a JSON array, got ${typeof list}.`,
    );
  }
  if (list.length === 0) throw new Error(`namespace ${namespace} has no repo mapping`);
  let chosen: { repo: string; label?: string } | undefined;
  if (selector) {
    chosen = list.find((r) => r.label === selector) ?? list.find((r) => r.repo === selector);
    if (!chosen) {
      const labels =
        list
          .map((r) => r.label)
          .filter(Boolean)
          .join(", ") || "(none)";
      const repos = list.map((r) => r.repo).join(", ");
      throw new Error(
        `repo '${selector}' is not mapped to namespace ${namespace}. Valid labels: ${labels}. Valid repos: ${repos}.`,
      );
    }
  } else {
    chosen = list.find((r) => r.label === "primary") ?? list[0];
  }
  const [owner, repo] = chosen.repo.split("/");
  if (!owner || !repo) throw new Error(`invalid repo entry for ${namespace}: ${chosen.repo}`);
  return { owner, repo, full: chosen.repo };
}

// encodePath keeps "/", so it cannot stop traversal alone: this inner guard refuses "." and ".."
// segments and repoApiUrl asserts the outer one. Exported for the traversal test.
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new Error(`refusing repo path with a '${segment}' segment: ${path}`);
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

// Refuses a caller-supplied repo argument at the door, naming it; repoApiUrl's assertion is the
// backstop. Covers arguments that reach GitHub through encodeURIComponent.
export function assertRepoArg(kind: string, value: string): void {
  const problem = repoPathProblem(value);
  if (problem) throw new Error(`${kind} ${problem}`);
}

export async function getDefaultBranch(env: Env, owner: string, repo: string): Promise<string> {
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}`);
  if (!resp.ok) throw new Error(`repo lookup failed (${resp.status}): ${await resp.text()}`);
  return ((await resp.json()) as { default_branch: string }).default_branch;
}

export async function getRefSha(
  env: Env,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (!resp.ok)
    throw new Error(`ref lookup failed for ${branch} (${resp.status}): ${await resp.text()}`);
  return ((await resp.json()) as { object: { sha: string } }).object.sha;
}

export async function defaultBranchSha(
  env: Env,
  namespace: string,
  repoSelector?: string,
): Promise<string> {
  const { owner, repo } = await resolveRepo(env, namespace, repoSelector);
  const branch = await getDefaultBranch(env, owner, repo);
  return getRefSha(env, owner, repo, branch);
}
