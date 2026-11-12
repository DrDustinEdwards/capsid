import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { parseReposList } from "./github/client";
import { readNpm, readNpmVersions, readPackageConfig, type FetchLike } from "./ops-packages";
import {
  asTag,
  noBloatJobs,
  npmLockVersions,
  pnpmLockVersions,
  workflowPins,
  type NoBloatJob,
} from "./lockfiles";
import { bundledModel } from "./public-data";
import type { SystemModel } from "./system-model";
import type { PackageSnapshot } from "./ops-types/sites";
import type { SharedCodeApp, SharedCodePackage, SharedCodeView } from "./ops-types/feed";
import { fromBase64Text } from "@dustinedwards/site-runtime/encoding";

import { errorMessage } from "@dustinedwards/site-runtime/log";

// SHARED CODE: how far the centralization has got (job_584b4e7f2824; ruling
// capsid/rulings/shared-homes-2026-10-06.md). For each shared package in configuration
// (shared_packages, migrations/0036): its newest tag, the tag each app pins, how many
// releases behind each app is, and how many known local copies are still in the apps.
//
// THE VERSIONS MODEL (Dustin, 2026-11-03: which Enarratio, Capsomer and devkit version each
// site is pinned to, so a fix does not mean hunting through every repo). The apps are every
// repo system/model.json names, each read on its default branch through the GitHub App: one
// recursive tree, then every package.json outside node_modules (up to MANIFESTS_PER_APP),
// the lockfile that covers it (package-lock.json or pnpm-lock.yaml, src/lockfiles.ts), the
// Renovate config and the workflow files. The packages are the shared ones (shared_packages,
// git dependencies, "github:DrDustinEdwards/<repo>#v1.2.3") and the published ones the
// Packages view watches (ops_packages: Enarratio and its Astro packages, from npm). A pin is
// the version the lockfile installed, else the tag the spec names. devkit is also a
// Renovate preset ("github>DrDustinEdwards/devkit") and a set of reusable workflows
// ("uses: DrDustinEdwards/devkit/.github/workflows/x.yml@<sha> # v0.21.0"), so it is found
// in those too. The nightly build (src/system-facts.ts) publishes it per system
// (src/system-versions.ts) and lists drift.
//
// Release tracking (Capsid improvement list, item 13): each package's own repo is read
// too, for the version in its root package.json on the default branch, whether that
// version has a release tag yet (untagged), and, when the package.json is not private,
// npm's latest dist-tag from the registry's abbreviated document (src/ops-packages.ts,
// readNpm). So each panel says tagged, on npm, and which apps are behind. The daily
// maintenance pass tags an untagged version (src/maintenance-releases.ts), using
// releaseDecision below, so the view and the pass agree on what "untagged" means.
//
// Read nightly by src/system-facts.ts and kept in KV, where the Portal (GET
// /portal/api/shared-code) reads it: a few hundred GitHub reads a night, not per page.
// The Portal reads afresh only when nothing is kept. Read-only: it writes nothing but its
// own cache. The key's version moves when the view's shape does, so a cached answer
// without the newer fields is never served.

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

interface SharedRow {
  name: string;
  repo: string;
  formerly: string;
  local_paths: string;
}

export interface SharedConfig {
  name: string;
  repo: string;
  // git when absent: a GitHub dependency. npm: matched by package name in the manifests.
  registry?: "git" | "npm";
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

export async function readSharedConfig(db: D1Database): Promise<SharedConfig[]> {
  const { results } = await db
    .prepare("SELECT name, repo, formerly, local_paths FROM shared_packages ORDER BY name LIMIT 50")
    .all<SharedRow>();
  return (results ?? []).map((r) => ({
    name: r.name,
    repo: r.repo,
    formerly: jsonList(r.formerly),
    local_paths: jsonList(r.local_paths),
  }));
}

// ---- pure parts ----------------------------------------------------------------------

/** "owner/repo" lower-cased, from any GitHub spelling npm accepts, with its ref; or null. */
export function gitSpec(spec: string): { repo: string; ref: string | null } | null {
  const s = spec.trim();
  const m =
    /^(?:github:)?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/.exec(s) ??
    /^git\+(?:https|ssh):\/\/(?:git@)?github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/.exec(
      s,
    ) ??
    /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:#(.+))?$/.exec(s);
  if (!m) return null;
  // A bare "a/b" without github: and without a ref is a path or a scope, not a repo.
  if (
    !s.startsWith("github:") &&
    !s.startsWith("git+") &&
    !s.startsWith("https://") &&
    m[2] === undefined
  )
    return null;
  return { repo: m[1].toLowerCase(), ref: m[2] ?? null };
}

/** A Renovate extends entry naming a GitHub preset repo, with its ref. */
export function presetSpec(entry: string): { repo: string; ref: string | null } | null {
  const m = /^github>([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?::[^#]+)?(?:#(.+))?$/.exec(entry.trim());
  return m ? { repo: m[1].toLowerCase(), ref: m[2] ?? null } : null;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function semver(tag: string): [number, number, number] | null {
  const m = SEMVER.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function cmp(a: [number, number, number], b: [number, number, number]): number {
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

/** What a repo's root package.json says about a release: the name npm knows it by, its
 *  version, and whether it is private (never published). */
export interface RootManifest {
  name: string | null;
  version: string | null;
  private: boolean;
}

/** The release fields of a package.json's text. Throws when it is not a JSON object. */
export function rootManifest(raw: string): RootManifest {
  const j: unknown = JSON.parse(raw);
  if (!j || typeof j !== "object" || Array.isArray(j))
    throw new Error("package.json is not a JSON object");
  const o = j as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : null,
    version: typeof o.version === "string" ? o.version : null,
    private: o.private === true,
  };
}

/**
 * What a package's version asks for, given the repo's tags:
 * - tagged: a tag names this version already (v1.2.3 or 1.2.3);
 * - tag: no tag names it and it is newer than every release tag, so it is the next release;
 * - backwards: no tag names it but a newer release tag exists. Never tagged: the tag would
 *   start bump-consumers on an older version and move the apps backwards. Listed instead;
 * - not-a-release: no version, or not a plain x.y.z (a pre-release is tagged by hand).
 */
export type ReleaseDecision =
  | { kind: "tagged"; tag: string }
  | { kind: "tag"; tag: string; newest: string | null }
  | { kind: "backwards"; tag: string; newest: string }
  | { kind: "not-a-release"; version: string | null };

export function releaseDecision(version: string | null, tags: readonly string[]): ReleaseDecision {
  const v = version !== null && /^\d+\.\d+\.\d+$/.test(version) ? semver(version) : null;
  if (!v) return { kind: "not-a-release", version };
  const existing = tags.find((t) => {
    const s = semver(t);
    return s !== null && cmp(s, v) === 0;
  });
  if (existing) return { kind: "tagged", tag: existing };
  const tag = `v${version}`;
  const newest = latestTag(tags);
  if (newest && cmp(v, semver(newest)!) < 0) return { kind: "backwards", tag, newest };
  return { kind: "tag", tag, newest };
}

/** What was read of a package's own repo and of npm, or why the repo was not read. */
export interface ReleaseRead {
  manifest: RootManifest | string;
  npm: PackageSnapshot["npm"] | null;
}

export interface AppRead {
  namespace: string;
  name: string;
  system?: string;
  repo?: string;
  blobs: Set<string> | null;
  // Each manifest's dependencies of every kind, by path, and the versions its lockfile installed.
  manifests: Array<{
    path: string;
    deps: Record<string, string>;
    lockVersions: Record<string, string>;
  }>;
  presets: string[];
  // Each workflow file's `uses:` pins, and its jobs that call devkit's no-bloat check.
  workflows?: Array<{
    path: string;
    pins: Array<{ repo: string; ref: string }>;
    no_bloat?: NoBloatJob[];
  }>;
  error: string | null;
}

/** The view, from what was read. Pure, so every rule is tested without GitHub. */
export function sharedCodeView(
  config: readonly SharedConfig[],
  tags: ReadonlyMap<string, string[] | string>,
  apps: readonly AppRead[],
  now: Date,
  releases: ReadonlyMap<string, ReleaseRead> = new Map(),
  tagShas: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): SharedCodeView {
  const packages: SharedCodePackage[] = config.map((pkg) => {
    const names = new Set([pkg.repo, ...pkg.formerly].map((r) => r.toLowerCase()));
    const t = tags.get(pkg.name);
    const list = Array.isArray(t) ? t : [];
    const latest = latestTag(list);
    // Without the tags, how far behind is unknown, never zero.
    const behind = (pinned: string | null) => (Array.isArray(t) ? behindBy(pinned, list) : null);
    const npm = pkg.registry === "npm";
    // An npm package is known by its name and any earlier one.
    const npmNames = new Set([pkg.name, ...pkg.formerly]);
    const users: SharedCodeApp[] = [];
    for (const app of apps) {
      const who = {
        namespace: app.namespace,
        name: app.name,
        system: app.system ?? null,
        repo: app.repo ?? null,
      };
      for (const m of app.manifests) {
        for (const [dep, spec] of Object.entries(m.deps)) {
          const g = gitSpec(spec);
          if (npm) {
            if (g || !npmNames.has(dep) || /^(?:workspace|file|link):/.test(spec)) continue;
            const exact = /^v?\d+\.\d+\.\d+$/.test(spec)
              ? spec.startsWith("v")
                ? spec
                : `v${spec}`
              : null;
            const pinned = m.lockVersions[dep] ?? exact;
            users.push({
              ...who,
              where: m.path,
              pinned,
              behind: behind(pinned),
              via_old_name: dep !== pkg.name,
            });
            continue;
          }
          if (!g || !names.has(g.repo)) continue;
          const pinned = m.lockVersions[dep] ?? g.ref ?? null;
          users.push({
            ...who,
            where: m.path,
            pinned,
            behind: behind(pinned),
            via_old_name: g.repo !== pkg.repo.toLowerCase(),
          });
        }
      }
      if (npm) continue;
      for (const entry of app.presets) {
        const p = presetSpec(entry);
        if (!p || !names.has(p.repo)) continue;
        users.push({
          ...who,
          where: "renovate",
          pinned: p.ref,
          behind: behind(p.ref),
          via_old_name: p.repo !== pkg.repo.toLowerCase(),
        });
      }
      // One row per version the workflows pin, so a repo whose files disagree shows both.
      const byPin = new Map<string | null, { files: number; old: boolean }>();
      // A sha is the release whose tag points at it, read from the tags, never from the comment beside it; a sha no
      // tag names is itself (no release, so no check of a release runs), and unknown when the tags were not read.
      const shas = tagShas.get(pkg.name);
      const version = (ref: string): string | null =>
        /^[0-9a-f]{40}$/i.test(ref)
          ? Array.isArray(t)
            ? (shas?.get(ref.toLowerCase()) ?? ref.toLowerCase())
            : null
          : /^v?\d+\.\d+\.\d+$/.test(ref)
            ? asTag(ref)
            : null;
      for (const w of app.workflows ?? []) {
        for (const pin of w.pins) {
          if (!names.has(pin.repo)) continue;
          const pinned = version(pin.ref);
          const row = byPin.get(pinned) ?? { files: 0, old: false };
          row.files += 1;
          row.old ||= pin.repo !== pkg.repo.toLowerCase();
          byPin.set(pinned, row);
        }
      }
      for (const [pinned, row] of byPin) {
        users.push({
          ...who,
          where: `.github/workflows (${row.files} ${row.files === 1 ? "use" : "uses"})`,
          pinned,
          behind: behind(pinned),
          via_old_name: row.old,
        });
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
    const release = releaseFields(releases.get(pkg.name), Array.isArray(t) ? list : null);
    return {
      name: pkg.name,
      repo: pkg.repo,
      registry: npm ? "npm" : "git",
      latest,
      tags_error: typeof t === "string" ? t : null,
      ...release,
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
    apps_failed: apps
      .filter((a) => a.error !== null)
      .map((a) =>
        a.system
          ? { namespace: a.namespace, system: a.system, error: a.error! }
          : { namespace: a.namespace, error: a.error! },
      ),
    packages,
    no_bloat_off: noBloatOff(apps),
  };
}

/** The repos with a root package.json where no workflow job runs devkit's no-bloat check: none calls pr.yml or
 *  no-bloat.yml, or each that does turns it off. A private repository passes `no-bloat: false` to pr.yml and runs
 *  no-bloat.yml weekly, so it is on. Only what was read is judged; a repo that could not be read is apps_failed's. */
function noBloatOff(apps: readonly AppRead[]): NonNullable<SharedCodeView["no_bloat_off"]> {
  const out: NonNullable<SharedCodeView["no_bloat_off"]> = [];
  for (const app of apps) {
    if (app.error !== null || !app.manifests.some((m) => m.path === "package.json")) continue;
    const jobs = (app.workflows ?? []).flatMap((w) =>
      (w.no_bloat ?? []).map((j) => ({ ...j, path: w.path })),
    );
    if (jobs.some((j) => j.off === null)) continue;
    const repo = app.repo ?? app.namespace;
    out.push({
      namespace: app.namespace,
      repo: app.repo ?? null,
      line: jobs.length
        ? `${repo} runs no no-bloat check: ${jobs.map((j) => `${j.path}: ${j.off}`).join("; ")}. Turn it back on, or find who turned it off.`
        : `${repo} runs no no-bloat check: no workflow calls devkit's pr.yml or no-bloat.yml. Add the caller (devkit examples/pr-caller.yml).`,
    });
  }
  return out;
}

type ReleaseFields = Pick<
  SharedCodePackage,
  "version" | "untagged" | "private" | "npm_latest" | "npm_note" | "manifest_error"
>;

/** A package's release fields. Untagged only when the tags were read and none names the
 *  version: without the tags it is unknown, and unknown is not untagged. */
function releaseFields(
  read: ReleaseRead | undefined,
  tags: readonly string[] | null,
): ReleaseFields {
  const unread = {
    version: null,
    untagged: false,
    private: false,
    npm_latest: null,
    npm_note: null,
  };
  if (!read) return { ...unread, manifest_error: null };
  if (typeof read.manifest === "string") return { ...unread, manifest_error: read.manifest };
  const m = read.manifest;
  const decision = tags ? releaseDecision(m.version, tags) : null;
  const untagged = decision?.kind === "tag" || decision?.kind === "backwards";
  let npm_latest: string | null = null;
  let npm_note: string | null = null;
  if (m.private) npm_note = null;
  else if (!m.name) npm_note = "package.json has no name";
  else if (!read.npm) npm_note = "npm was not read";
  else if (read.npm.state === "ok") {
    npm_latest = read.npm.latest;
    if (!npm_latest) npm_note = "npm has no latest dist-tag";
  } else npm_note = read.npm.reason;
  return {
    version: m.version,
    untagged,
    private: m.private,
    npm_latest,
    npm_note,
    manifest_error: null,
  };
}

// ---- reading -------------------------------------------------------------------------

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
