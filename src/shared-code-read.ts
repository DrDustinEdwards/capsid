import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { parseReposList } from "./github/client";
import { readNpm, readNpmVersions, type FetchLike } from "./ops-packages";
import { readPackageConfig } from "./ops-package-config";
import { noBloatJobs, npmLockVersions, pnpmLockVersions, workflowPins } from "./lockfiles";
import { bundledModel } from "./public-data";
import type { SystemModel } from "./system-model";
import type { SharedCodeView } from "./ops-types/feed";
import { fromBase64Text } from "@dustinedwards/site-runtime/encoding";

import { errorMessage } from "@dustinedwards/site-runtime/log";
import {
  gitSpec,
  rootManifest,
  sharedCodeView,
  type AppRead,
  type ReleaseRead,
  type RootManifest,
  type SharedConfig,
  readSharedConfig,
} from "./shared-code";

export const SHARED_CODE_CACHE_KEY = "portal:shared-code:v3";
// The nightly build (src/system-facts.ts) writes the view; the Portal reads that. Kept a
// day and a half, so a build that stops leaves the view to be read afresh, not served stale.
const CACHE_TTL_SECONDS = 36 * 3600;
const APP_CONCURRENCY = 6;
const MANIFESTS_PER_APP = 16;
const WORKFLOWS_PER_APP = 40;
const TAGS_PER_PAGE = 100;
const RENOVATE_FILES = [
  "renovate.json",
  ".github/renovate.json",
  "renovate.json5",
  ".github/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
];

/** A repo's root package.json, on its default branch or at `ref`, through the App.
 *  Uncached: the release-tag rule reads it to decide a write. */
export async function readRootManifest(
  env: Env,
  full: string,
  ref?: string,
): Promise<RootManifest> {
  const [owner, repo] = full.split("/");
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/contents/package.json${query}`,
  );
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(
      `GitHub answered ${resp.status} for ${full}'s package.json${ref ? ` at ${ref.slice(0, 12)}` : ""}`,
    );
  }
  const data = (await resp.json()) as { content?: unknown; encoding?: unknown };
  if (data.encoding !== "base64" || typeof data.content !== "string")
    throw new Error(`${full}'s package.json came back without its content`);
  return rootManifest(fromBase64Text(data.content));
}

async function readRelease(env: Env, full: string, fetchImpl: FetchLike): Promise<ReleaseRead> {
  let manifest: RootManifest;
  try {
    manifest = await readRootManifest(env, full);
  } catch (err) {
    return { manifest: errorMessage(err), npm: null };
  }
  const npm = manifest.private || !manifest.name ? null : await readNpm(fetchImpl, manifest.name);
  return { manifest, npm };
}

function depsOf(raw: string): Record<string, string> {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const block = j[key];
    if (block && typeof block === "object")
      for (const [k, v] of Object.entries(block)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** One file of a repo on its default branch, as text, through the App, uncached: the
 *  nightly build reads a few hundred files and would otherwise write as many cache keys. */
async function rawFile(env: Env, full: string, path: string): Promise<string> {
  const [owner, repo] = full.split("/");
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { Accept: "application/vnd.github.raw+json" } },
  );
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`GitHub answered ${resp.status} for ${full}'s ${path}`);
  }
  return resp.text();
}

/** Every blob path on the default branch, or an error when the tree is missing or truncated. */
async function blobPaths(env: Env, full: string): Promise<Set<string>> {
  const [owner, repo] = full.split("/");
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
  );
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`its file tree could not be read (GitHub answered ${resp.status})`);
  }
  const tree = (await resp.json()) as {
    tree?: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };
  if (!Array.isArray(tree.tree) || tree.truncated)
    throw new Error("its file tree is too large to read whole");
  return new Set(tree.tree.filter((e) => e.type === "blob").map((e) => e.path));
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The nearest lockfile at or above `dir`: its directory and kind. */
function lockFor(blobs: Set<string>, dir: string): { dir: string; kind: "npm" | "pnpm" } | null {
  for (let d = dir; ; d = dirOf(d)) {
    const at = (f: string) => (d ? `${d}/${f}` : f);
    if (blobs.has(at("package-lock.json"))) return { dir: d, kind: "npm" };
    if (blobs.has(at("pnpm-lock.yaml"))) return { dir: d, kind: "pnpm" };
    if (!d) return null;
  }
}

async function readApp(
  env: Env,
  target: { namespace: string; name: string; system: string; repo: string },
  watched: ReadonlySet<string>,
): Promise<AppRead> {
  const app: AppRead = {
    ...target,
    blobs: null,
    manifests: [],
    presets: [],
    workflows: [],
    error: null,
  };
  const locks = new Map<string, Promise<string>>();
  const lockText = (path: string) => {
    if (!locks.has(path)) locks.set(path, rawFile(env, target.repo, path));
    return locks.get(path)!;
  };
  try {
    const blobs = await blobPaths(env, target.repo);
    app.blobs = blobs;
    const manifests = [...blobs]
      .filter(
        (p) =>
          (p === "package.json" || p.endsWith("/package.json")) && !p.includes("node_modules/"),
      )
      .sort((a, b) => a.split("/").length - b.split("/").length)
      .slice(0, MANIFESTS_PER_APP);
    for (const path of manifests) {
      const deps = depsOf(await rawFile(env, target.repo, path));
      // Only the dependencies a package is matched on are looked up in the lockfile.
      const wanted = Object.entries(deps)
        .filter(([dep, spec]) => watched.has(dep) || gitSpec(spec) !== null)
        .map(([dep]) => dep);
      let lockVersions: Record<string, string> = {};
      const lock = wanted.length ? lockFor(blobs, dirOf(path)) : null;
      if (lock) {
        const file = `${lock.dir ? `${lock.dir}/` : ""}${lock.kind === "npm" ? "package-lock.json" : "pnpm-lock.yaml"}`;
        const text = await lockText(file);
        lockVersions =
          lock.kind === "npm"
            ? npmLockVersions(text, lock.dir, dirOf(path), wanted)
            : pnpmLockVersions(text, lock.dir, dirOf(path), wanted);
      }
      app.manifests.push({ path, deps, lockVersions });
    }
    for (const path of RENOVATE_FILES) {
      if (!blobs.has(path)) continue;
      // renovate.json5 allows comments; the extends line is read either way.
      const text = await rawFile(env, target.repo, path);
      app.presets.push(...[...text.matchAll(/"(github>[^"]+)"/g)].map((m) => m[1]));
    }
    const workflows = [...blobs]
      .filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))
      .sort()
      .slice(0, WORKFLOWS_PER_APP);
    for (const path of workflows) {
      const text = await rawFile(env, target.repo, path);
      app.workflows!.push({ path, pins: workflowPins(text), no_bloat: noBloatJobs(text) });
    }
  } catch (err) {
    app.error = errorMessage(err);
  }
  return app;
}

/** The repos the model names, once each, with the system that owns each and the namespace
 *  that maps it. A repo several systems share (a site and its admin MCP) is read once, under
 *  the system named for the repo, else the one with a domain, else the first. */
function modelApps(
  model: SystemModel,
  namespaceOf: ReadonlyMap<string, string>,
): Array<{ namespace: string; name: string; system: string; repo: string }> {
  const byRepo = new Map<string, SystemModel["systems"]>();
  for (const s of model.systems)
    for (const r of s.repos) byRepo.set(r, [...(byRepo.get(r) ?? []), s]);
  return [...byRepo].map(([repo, systems]) => {
    const short = repo.split("/")[1].toLowerCase();
    const owner =
      systems.find((s) => s.id === short) ?? systems.find((s) => s.domain) ?? systems[0];
    return {
      namespace: namespaceOf.get(repo.toLowerCase()) ?? owner.id,
      name: owner.name,
      system: owner.id,
      repo,
    };
  });
}

async function readTags(
  env: Env,
  full: string,
): Promise<Array<{ name: string; sha: string }> | string> {
  const [owner, repo] = full.split("/");
  const resp = await ghFetch(
    env,
    owner,
    repo,
    `/repos/${owner}/${repo}/tags?per_page=${TAGS_PER_PAGE}`,
  );
  if (!resp.ok) return `GitHub answered ${resp.status} for ${full}'s tags`;
  return ((await resp.json()) as Array<{ name: string; commit: { sha: string } }>).map((t) => ({
    name: t.name,
    sha: t.commit.sha.toLowerCase(),
  }));
}

/** The view, from the hour's cache unless `fresh`. A missing table says so. */
export async function readSharedCode(
  env: Env,
  now: Date,
  fresh = false,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  model: SystemModel = bundledModel(),
): Promise<SharedCodeView> {
  // Only a configured view is kept: a missing table or an empty config is read again next time.
  return kvCached(
    env.APP_KV,
    SHARED_CODE_CACHE_KEY,
    { ttl: CACHE_TTL_SECONDS, refresh: fresh, keep: (view) => view.configured },
    () => buildSharedCode(env, now, fetchImpl, model),
  );
}

async function buildSharedCode(
  env: Env,
  now: Date,
  fetchImpl: FetchLike,
  model: SystemModel,
): Promise<SharedCodeView> {
  let config: SharedConfig[];
  try {
    config = await readSharedConfig(env.DB);
  } catch (err) {
    const why = errorMessage(err);
    return {
      generated: now.toISOString(),
      configured: false,
      error: /no such table/i.test(why)
        ? "shared_packages does not exist yet: migrations/0036_shared_packages.sql is the seat's to apply"
        : why,
      apps_read: 0,
      apps_failed: [],
      packages: [],
    };
  }
  // The published packages the Packages view watches, matched by name. Optional: a
  // missing table is no npm packages, not a failed view.
  const published = await readPackageConfig(env.DB).catch(() => []);
  for (const p of published) {
    if (p.repo)
      config.push({
        name: p.name,
        repo: p.repo,
        registry: "npm",
        formerly: p.formerly ? [p.formerly] : [],
        local_paths: [],
      });
  }
  if (config.length === 0)
    return {
      generated: now.toISOString(),
      configured: false,
      error: null,
      apps_read: 0,
      apps_failed: [],
      packages: [],
    };
  const rows =
    (
      await env.DB.prepare("SELECT namespace, repos FROM namespaces").all<{
        namespace: string;
        repos: string;
      }>()
    ).results ?? [];
  const namespaceOf = new Map<string, string>();
  for (const row of rows) {
    const parsed = parseReposList(row.repos);
    if ("list" in parsed)
      for (const r of parsed.list)
        if (!namespaceOf.has(r.repo.toLowerCase()))
          namespaceOf.set(r.repo.toLowerCase(), row.namespace);
  }
  const watched = new Set(
    config.filter((c) => c.registry === "npm").flatMap((c) => [c.name, ...c.formerly]),
  );
  // A few repos at a time: one repo is a few dozen reads, and the nightly build has the
  // tick's four minutes for everything.
  const targets = modelApps(model, namespaceOf);
  const apps = Array.from<AppRead>({ length: targets.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(APP_CONCURRENCY, targets.length) }, async () => {
      for (let i = next++; i < targets.length; i = next++)
        apps[i] = await readApp(env, targets[i], watched);
    }),
  );
  const tags = new Map<string, string[] | string>();
  const tagShas = new Map<string, Map<string, string>>();
  const failed = (err: unknown) => errorMessage(err);
  for (const pkg of config) {
    if (pkg.registry === "npm") {
      tags.set(pkg.name, await readNpmVersions(fetchImpl, pkg.name).catch(failed));
      continue;
    }
    const read = await readTags(env, pkg.repo).catch(failed);
    tags.set(pkg.name, typeof read === "string" ? read : read.map((r) => r.name));
    if (typeof read !== "string") tagShas.set(pkg.name, new Map(read.map((r) => [r.sha, r.name])));
  }
  const releases = new Map<string, ReleaseRead>();
  // A published package's repo may hold several packages (the Astro workspace), so its
  // root package.json says nothing about it; its release is npm's.
  for (const pkg of config)
    if (pkg.registry !== "npm") releases.set(pkg.name, await readRelease(env, pkg.repo, fetchImpl));
  return sharedCodeView(config, tags, apps, now, releases, tagShas);
}
