// What a repo's lockfile says it installed: the version of each named dependency, per
// manifest directory. The versions model (src/shared-code.ts) reads it so a pin is what the
// repo actually installs, not only what its package.json asks for ("^0.7.0" asks for a
// range; the lockfile names 0.7.3).
//
// Two formats, both parsed by hand so the Worker carries no YAML library:
//   npm's package-lock.json, lockfileVersion 2 and 3: `packages`, keyed by install path.
//     A workspace's own dependency sits at "<workspace>/node_modules/<name>" when it
//     differs from the hoisted one at "node_modules/<name>"
//     (docs.npmjs.com/cli/configuring-npm/package-lock-json).
//   pnpm's pnpm-lock.yaml, lockfileVersion 9: `importers`, keyed by the manifest's
//     directory ("." for the root), each dependency with a `specifier` and a `version`.
//     A git dependency's version is its tarball URL with peers in parentheses; the
//     version number is under `packages`, keyed "<name>@<that URL>"
//     (pnpm.io/git, the lockfile section; checked against Foxing's lockfile 2026-11-03).

/** "v" plus the version, the spelling the tags use. */
const asTag = (v: string) => (v.startsWith("v") ? v : `v${v}`);

/** The installed version of each of `names`, for the manifest in `dir` ("" for the root),
 *  from a package-lock.json at `lockDir`. Missing names are left out. */
export function npmLockVersions(
  raw: string,
  lockDir: string,
  dir: string,
  names: readonly string[],
): Record<string, string> {
  let lock: { packages?: Record<string, { version?: unknown }> };
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch {
    return {};
  }
  const packages = lock.packages ?? {};
  const rel = relative(lockDir, dir);
  const out: Record<string, string> = {};
  for (const name of names) {
    const own = rel ? packages[`${rel}/node_modules/${name}`]?.version : undefined;
    const hoisted = packages[`node_modules/${name}`]?.version;
    const v = typeof own === "string" ? own : typeof hoisted === "string" ? hoisted : null;
    if (v) out[name] = asTag(v);
  }
  return out;
}

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^'(.*)'$/, "$1")
    .replace(/^"(.*)"$/, "$1");
const indentOf = (line: string) => line.length - line.trimStart().length;

/** The installed version of each of `names`, for the manifest in `dir`, from a
 *  pnpm-lock.yaml at `lockDir`. Missing names are left out. */
export function pnpmLockVersions(
  raw: string,
  lockDir: string,
  dir: string,
  names: readonly string[],
): Record<string, string> {
  const want = new Set(names);
  const importer = relative(lockDir, dir) || ".";
  const lines = raw.split(/\r?\n/);
  const found = new Map<string, string>();
  const gitVersions = new Map<string, string>();

  let section = "";
  let inImporter = false;
  let dep: string | null = null;
  let pkgKey: string | null = null;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      section = line.replace(/:.*$/, "");
      inImporter = false;
      dep = null;
      pkgKey = null;
      continue;
    }
    const text = line.trim();
    if (section === "importers") {
      if (indent === 2) {
        inImporter = unquote(text.replace(/:$/, "")) === importer;
        dep = null;
      } else if (inImporter && indent === 6) {
        const name = unquote(text.replace(/:$/, ""));
        dep = want.has(name) ? name : null;
      } else if (inImporter && dep && indent === 8 && text.startsWith("version:")) {
        found.set(dep, text.slice("version:".length).trim());
      }
    } else if (section === "packages") {
      if (indent === 2) pkgKey = unquote(text.replace(/:$/, ""));
      else if (pkgKey && indent === 4 && text.startsWith("version:"))
        gitVersions.set(pkgKey, unquote(text.slice("version:".length)));
    }
  }

  const out: Record<string, string> = {};
  for (const [name, version] of found) {
    // Peers ride in parentheses after the version or the URL.
    const bare = version.replace(/\(.*$/, "");
    const v = /^\d+\.\d+\.\d+/.test(bare) ? bare : (gitVersions.get(`${name}@${bare}`) ?? null);
    if (v) out[name] = asTag(v);
  }
  return out;
}

/** `dir` relative to `base`, both repo-relative directories ("" for the root). */
function relative(base: string, dir: string): string {
  if (!base) return dir;
  return dir === base ? "" : dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
}

/** The devkit-style reusable workflow and action pins in one workflow file: each
 *  `uses: owner/repo/...@ref`, with the version its trailing "# vX.Y.Z" comment names (the
 *  spelling Renovate writes beside a sha), or the ref itself when that is a version. */
export function workflowPins(text: string): Array<{ repo: string; pinned: string | null }> {
  const out: Array<{ repo: string; pinned: string | null }> = [];
  for (const m of text.matchAll(
    /^\s*-?\s*uses:\s*["']?([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)(?:\/[^@\s"']*)?@([^\s"'#]+)["']?(?:\s*#\s*(v?\d+\.\d+\.\d+))?/gm,
  )) {
    const ref = m[2];
    const pinned = m[3] ? asTag(m[3]) : /^v?\d+\.\d+\.\d+$/.test(ref) ? asTag(ref) : null;
    out.push({ repo: m[1].toLowerCase(), pinned });
  }
  return out;
}

/** How a workflow runs devkit's no-bloat check: each job that calls pr.yml or no-bloat.yml, and why it is off, if it is. */
export interface NoBloatJob {
  job: string;
  workflow: "pr" | "no-bloat";
  /** Why the job does not run the check: pr.yml's `no-bloat: false` or `node: false`, or an `if` on the job. Null: on. */
  off: string | null;
}

/** Each job in one workflow file that calls devkit's pr.yml or no-bloat.yml, read line by line as a caller is written
 *  (the job's `uses`, `if` and `with` at one indent, its inputs one level in), the way devkit's no-bloat bin reads it
 *  (callerJobs): a pull request that turns the check off is refused there, and this is the nightly look at what merged. */
export function noBloatJobs(text: string): NoBloatJob[] {
  const lines = text.split("\n");
  const indent = (l: string) => l.length - l.trimStart().length;
  const content = (l: string) => l.trim() !== "" && !l.trim().startsWith("#");
  const out: NoBloatJob[] = [];
  lines.forEach((line, u) => {
    const m =
      /^(\s*)uses:\s*["']?DrDustinEdwards\/devkit\/\.github\/workflows\/(pr|no-bloat)\.yml@/i.exec(
        line,
      );
    if (!m) return;
    const at = m[1].length;
    let j = u - 1;
    while (j >= 0 && !(content(lines[j]) && indent(lines[j]) < at)) j--;
    if (j < 0) return;
    const job: NoBloatJob = {
      job: lines[j].trim().replace(/:\s*$/, ""),
      workflow: m[2].toLowerCase() as "pr" | "no-bloat",
      off: null,
    };
    let inWith = false;
    for (let k = j + 1; k < lines.length; k++) {
      const l = lines[k];
      if (!content(l)) continue;
      if (indent(l) <= indent(lines[j])) break;
      if (indent(l) === at) {
        inWith = /^\s*with:\s*$/.test(l);
        const cond = /^\s*if:\s*(.+)$/.exec(l);
        if (cond) job.off = `the job "${job.job}" runs only if ${cond[1].trim()}`;
      } else if (inWith && job.workflow === "pr" && !job.off) {
        const off = /^\s*(no-bloat|node):\s*["']?false["']?\s*(?:#.*)?$/.exec(l);
        if (off) job.off = `the job "${job.job}" passes ${off[1]}: false`;
      }
    }
    out.push(job);
  });
  return out;
}
