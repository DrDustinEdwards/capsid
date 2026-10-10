import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { readRepoFile, repoBlobPaths } from "./github/contents";
import { readSiteConfig } from "./ops-sites";
import type { SharedCodeApp, SharedCodePackage, SharedCodeView } from "./ops-types";

// SHARED CODE: how far the centralization has got (job_584b4e7f2824; ruling
// capsid/rulings/shared-homes-2026-10-06.md). For each shared package in configuration
// (shared_packages, migrations/0036): its newest tag, the tag each app pins, how many
// releases behind each app is, and how many known local copies are still in the apps.
//
// The apps are the configured sites' namespaces (ops_sites, the same list the inbox and
// the watcher use), each read on its default branch through the GitHub App the watcher
// already uses: one recursive tree, then every package.json outside node_modules (up to
// MANIFESTS_PER_APP) and the Renovate config. Every shared package is a git dependency
// ("github:DrDustinEdwards/<repo>#v1.2.3"), so the manifest names the tag itself; the
// lockfile is read only for a spec with no tag, for the version it resolved. devkit is
// a Renovate preset ("github>DrDustinEdwards/devkit"), so it is found in the Renovate
// config, not in a manifest.
//
// Read on demand by the Portal (GET /portal/api/shared-code) and kept for an hour in KV:
// a few dozen GitHub reads per refresh, not per watcher pass. Read-only: it writes
// nothing but its own cache.

export const SHARED_CODE_CACHE_KEY = "portal:shared-code:v1";
const CACHE_TTL_SECONDS = 3600;
const MANIFESTS_PER_APP = 8;
const TAGS_PER_PAGE = 100;
const RENOVATE_FILES = ["renovate.json", ".github/renovate.json", "renovate.json5", ".github/renovate.json5", ".renovaterc", ".renovaterc.json"];

interface SharedRow {
  name: string;
  repo: string;
  formerly: string;
  local_paths: string;
}

export interface SharedConfig {
  name: string;
  repo: string;
  // Earlier names of the repo (security-headers for site-runtime): an app still pinned
  // through GitHub's redirect counts as a consumer.
  formerly: string[];
  // Known local copies the package replaces, "namespace:path".
  local_paths: string[];
}

function jsonList(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function readSharedConfig(db: D1Database): Promise<SharedConfig[]> {
  const { results } = await db.prepare("SELECT name, repo, formerly, local_paths FROM shared_packages ORDER BY name LIMIT 50").all<SharedRow>();
  return (results ?? []).map((r) => ({ name: r.name, repo: r.repo, formerly: jsonList(r.formerly), local_paths: jsonList(r.local_paths) }));
}

// ---- pure parts ----------------------------------------------------------------------

/** "owner/repo" lower-cased, from any GitHub spelling npm accepts, with its ref; or null. */
export function gitSpec(spec: string): { repo: string; ref: string | null } | null {
  const s = spec.trim();
  const m =
    /^(?:github:)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/.exec(s) ??
    /^git\+(?:https|ssh):\/\/(?:git@)?github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/.exec(s) ??
    /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/.exec(s);
  if (!m) return null;
  // A bare "a/b" without github: and without a ref is a path or a scope, not a repo.
  if (!s.startsWith("github:") && !s.startsWith("git+") && !s.startsWith("https://") && m[2] === undefined) return null;
  return { repo: m[1].toLowerCase(), ref: m[2] ?? null };
}

/** A Renovate extends entry naming a GitHub preset repo, with its ref. */
export function presetSpec(entry: string): { repo: string; ref: string | null } | null {
  const m = /^github>([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?::[^#]+)?(?:#(.+))?$/.exec(entry.trim());
  return m ? { repo: m[1].toLowerCase(), ref: m[2] ?? null } : null;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function semver(tag: string): [number, number, number] | null {
  const m = SEMVER.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The newest release tag, by version, ignoring tags that are not x.y.z. */
export function latestTag(tags: readonly string[]): string | null {
  let best: { tag: string; v: [number, number, number] } | null = null;
  for (const tag of tags) {
    const v = semver(tag);
    if (v && (!best || cmp(v, best.v) > 0)) best = { tag, v };
  }
  return best?.tag ?? null;
}

/** How many release tags are newer than `pinned`, or null when the pin is not a release. */
export function behindBy(pinned: string | null, tags: readonly string[]): number | null {
  const p = pinned ? semver(pinned) : null;
  if (!p) return null;
  return tags.filter((t) => {
    const v = semver(t);
    return v !== null && cmp(v, p) > 0;
  }).length;
}

interface AppRead {
  namespace: string;
  name: string;
  blobs: Set<string> | null;
  // Each manifest's dependencies of every kind, by path.
  manifests: Array<{ path: string; deps: Record<string, string>; lockVersions: Record<string, string> }>;
  presets: string[];
  error: string | null;
}

/** The view, from what was read. Pure, so every rule is tested without GitHub. */
export function sharedCodeView(config: readonly SharedConfig[], tags: ReadonlyMap<string, string[] | string>, apps: readonly AppRead[], now: Date): SharedCodeView {
  const packages: SharedCodePackage[] = config.map((pkg) => {
    const names = new Set([pkg.repo, ...pkg.formerly].map((r) => r.toLowerCase()));
    const t = tags.get(pkg.name);
    const list = Array.isArray(t) ? t : [];
    const latest = latestTag(list);
    // Without the tags, how far behind is unknown, never zero.
    const behind = (pinned: string | null) => (Array.isArray(t) ? behindBy(pinned, list) : null);
    const users: SharedCodeApp[] = [];
    for (const app of apps) {
      for (const m of app.manifests) {
        for (const [dep, spec] of Object.entries(m.deps)) {
          const g = gitSpec(spec);
          if (!g || !names.has(g.repo)) continue;
          const pinned = g.ref ?? m.lockVersions[dep] ?? null;
          users.push({ namespace: app.namespace, name: app.name, where: m.path, pinned, behind: behind(pinned), via_old_name: g.repo !== pkg.repo.toLowerCase() });
        }
      }
      for (const entry of app.presets) {
        const p = presetSpec(entry);
        if (!p || !names.has(p.repo)) continue;
        users.push({ namespace: app.namespace, name: app.name, where: "renovate", pinned: p.ref, behind: behind(p.ref), via_old_name: p.repo !== pkg.repo.toLowerCase() });
      }
    }
    const local = pkg.local_paths.map((entry) => {
      const at = entry.indexOf(":");
      const namespace = at > 0 ? entry.slice(0, at) : "";
      const path = (at > 0 ? entry.slice(at + 1) : entry).replace(/\/+$/, "");
      const blobs = apps.find((a) => a.namespace === namespace)?.blobs ?? null;
      const present = blobs ? [...blobs].some((b) => b === path || b.startsWith(`${path}/`)) : null;
      return { namespace, path, present };
    });
    return {
      name: pkg.name,
      repo: pkg.repo,
      latest,
      tags_error: typeof t === "string" ? t : null,
      users,
      behind: users.filter((u) => (u.behind ?? 0) > 0).length,
      local_copies: local,
      local_left: local.filter((l) => l.present === true).length,
    };
  });
  return {
    generated: now.toISOString(),
    configured: true,
    error: null,
    apps_read: apps.filter((a) => a.error === null).length,
    apps_failed: apps.filter((a) => a.error !== null).map((a) => ({ namespace: a.namespace, error: a.error! })),
    packages,
  };
}

// ---- reading -------------------------------------------------------------------------

function depsOf(raw: string): Record<string, string> {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = j[key];
    if (block && typeof block === "object") for (const [k, v] of Object.entries(block)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function readApp(env: Env, namespace: string, name: string): Promise<AppRead> {
  const app: AppRead = { namespace, name, blobs: null, manifests: [], presets: [], error: null };
  try {
    app.blobs = await repoBlobPaths(env, namespace);
    if (!app.blobs) throw new Error("its file tree could not be read (missing, or too large)");
    const manifests = [...app.blobs].filter((p) => (p === "package.json" || p.endsWith("/package.json")) && !p.includes("node_modules/")).sort((a, b) => a.split("/").length - b.split("/").length).slice(0, MANIFESTS_PER_APP);
    for (const path of manifests) {
      const deps = depsOf((await readRepoFile(env, namespace, path)).content);
      const lockVersions: Record<string, string> = {};
      const untagged = Object.entries(deps).filter(([, spec]) => gitSpec(spec)?.ref === null);
      const lockPath = path.replace(/package\.json$/, "package-lock.json");
      if (untagged.length && app.blobs.has(lockPath)) {
        const lock = JSON.parse((await readRepoFile(env, namespace, lockPath)).content) as { packages?: Record<string, { version?: string }> };
        for (const [dep] of untagged) {
          const v = lock.packages?.[`node_modules/${dep}`]?.version;
          if (v) lockVersions[dep] = `v${v}`;
        }
      }
      app.manifests.push({ path, deps, lockVersions });
    }
    for (const path of RENOVATE_FILES) {
      if (!app.blobs.has(path)) continue;
      // renovate.json5 allows comments; the extends line is read either way.
      const text = (await readRepoFile(env, namespace, path)).content;
      app.presets.push(...[...text.matchAll(/"(github>[^"]+)"/g)].map((m) => m[1]));
    }
  } catch (err) {
    app.error = err instanceof Error ? err.message : String(err);
  }
  return app;
}

async function readTags(env: Env, full: string): Promise<string[] | string> {
  const [owner, repo] = full.split("/");
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/tags?per_page=${TAGS_PER_PAGE}`);
  if (!resp.ok) return `GitHub answered ${resp.status} for ${full}'s tags`;
  return ((await resp.json()) as Array<{ name: string }>).map((t) => t.name);
}

/** The view, from the hour's cache unless `fresh`. A missing table says so. */
export async function readSharedCode(env: Env, now: Date, fresh = false): Promise<SharedCodeView> {
  if (!fresh) {
    const cached = await env.APP_KV.get(SHARED_CODE_CACHE_KEY);
    if (cached) return JSON.parse(cached) as SharedCodeView;
  }
  let config: SharedConfig[];
  try {
    config = await readSharedConfig(env.DB);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { generated: now.toISOString(), configured: false, error: /no such table/i.test(why) ? "shared_packages does not exist yet: migrations/0036_shared_packages.sql is the seat's to apply" : why, apps_read: 0, apps_failed: [], packages: [] };
  }
  if (config.length === 0) return { generated: now.toISOString(), configured: false, error: null, apps_read: 0, apps_failed: [], packages: [] };
  const sites = await readSiteConfig(env.DB);
  const apps: AppRead[] = [];
  for (const s of sites) apps.push(await readApp(env, s.namespace, s.name));
  const tags = new Map<string, string[] | string>();
  for (const pkg of config) tags.set(pkg.name, await readTags(env, pkg.repo).catch((err: unknown) => (err instanceof Error ? err.message : String(err))));
  const view = sharedCodeView(config, tags, apps, now);
  await env.APP_KV.put(SHARED_CODE_CACHE_KEY, JSON.stringify(view), { expirationTtl: CACHE_TTL_SECONDS });
  return view;
}
