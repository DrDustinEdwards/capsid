import { asTag, type NoBloatJob } from "./lockfiles";
import type { PackageSnapshot } from "./ops-types/sites";
import type { SharedCodeApp, SharedCodePackage, SharedCodeView } from "./ops-types/feed";

// SHARED CODE: how far the centralization has got (capsid/rulings/shared-homes-2026-10-06.md). For each shared package in configuration
// (shared_packages, migrations/0036): its newest tag, the tag each app pins, how many
// releases behind each app is, and how many known local copies are still in the apps.
//
// THE VERSIONS MODEL (which Enarratio, Capsomer and devkit version each
// site is pinned to). The apps are every
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
