// What a repo's lockfile says it installed: the version of each named dependency, per
// manifest directory. The versions model (src/shared-code.ts) reads it so a pin is what the
// repo actually installs, not only what its package.json asks for ("^0.7.0" asks for a
// range; the lockfile names 0.7.3).
//
// Two formats:
//   npm's package-lock.json, lockfileVersion 2 and 3: `packages`, keyed by install path.
//     A workspace's own dependency sits at "<workspace>/node_modules/<name>" when it
//     differs from the hoisted one at "node_modules/<name>"
//     (docs.npmjs.com/cli/configuring-npm/package-lock-json).
//   pnpm's pnpm-lock.yaml, lockfileVersion 9: `importers`, keyed by the manifest's
//     directory ("." for the root), each dependency with a `specifier` and a `version`.
//     A git dependency's version is its tarball URL with peers in parentheses; the
//     version number is under `packages`, keyed "<name>@<that URL>"
//     (pnpm.io/git, the lockfile section; checked against Foxing's lockfile 2026-11-03).
// YAML (pnpm's lockfile, the workflows) is read with the `yaml` parser, as devkit's no-bloat bin reads a workflow, so
// any spelling YAML allows (flow maps, quoted keys, anchors, CRLF) is the same data.

import { parse } from "yaml";

/** A YAML document as data, or the error that stopped it. A key written twice fails, as GitHub refuses it. */
function readYaml(text: string): Record<string, unknown> | Error {
  try {
    const doc: unknown = parse(text, { uniqueKeys: true });
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const isMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** "v" plus the version, the spelling the tags use. */
export const asTag = (v: string) => (v.startsWith("v") ? v : `v${v}`);

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

/** The installed version of each of `names`, for the manifest in `dir`, from a
 *  pnpm-lock.yaml at `lockDir`. Missing names are left out. */
export function pnpmLockVersions(
  raw: string,
  lockDir: string,
  dir: string,
  names: readonly string[],
): Record<string, string> {
  const lock = readYaml(raw);
  if (lock instanceof Error) return {};
  const importers = isMap(lock.importers) ? lock.importers : {};
  const importer = importers[relative(lockDir, dir) || "."];
  const packages = isMap(lock.packages) ? lock.packages : {};
  const out: Record<string, string> = {};
  if (!isMap(importer)) return out;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = importer[field];
    if (!isMap(deps)) continue;
    for (const name of names) {
      const dep = deps[name];
      if (name in out || !isMap(dep) || typeof dep.version !== "string") continue;
      // Peers ride in parentheses after the version or the URL.
      const bare = dep.version.replace(/\(.*$/, "");
      const pkg = packages[`${name}@${bare}`];
      const v = /^\d+\.\d+\.\d+/.test(bare)
        ? bare
        : isMap(pkg) && typeof pkg.version === "string"
          ? pkg.version
          : null;
      if (v) out[name] = asTag(v);
    }
  }
  return out;
}

/** `dir` relative to `base`, both repo-relative directories ("" for the root). */
function relative(base: string, dir: string): string {
  if (!base) return dir;
  return dir === base ? "" : dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
}

/** Each `uses: owner/repo/...@ref` of one workflow file, a job's or a step's: the repo and the ref as written. The
 *  version a sha stands for comes from the repo's tags (sharedCodeView), never from the "# vX.Y.Z" comment beside it,
 *  which a change can leave as it was while the sha moves back. A file that does not parse has no pins. */
export function workflowPins(text: string): Array<{ repo: string; ref: string }> {
  const doc = readYaml(text);
  if (doc instanceof Error || !isMap(doc.jobs)) return [];
  const out: Array<{ repo: string; ref: string }> = [];
  const add = (uses: unknown) => {
    const m =
      typeof uses === "string"
        ? /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)(?:\/[^@\s]*)?@(\S+)$/.exec(uses.trim())
        : null;
    if (m) out.push({ repo: m[1].toLowerCase(), ref: m[2] });
  };
  for (const job of Object.values(doc.jobs)) {
    if (!isMap(job)) continue;
    add(job.uses);
    if (Array.isArray(job.steps)) for (const step of job.steps) if (isMap(step)) add(step.uses);
  }
  return out;
}

/** How a workflow runs devkit's no-bloat check: each job that calls pr.yml or no-bloat.yml, and why it is off, if it is. */
export interface NoBloatJob {
  job: string;
  workflow: "pr" | "no-bloat";
  /** Why the job does not run the check: pr.yml's `no-bloat` or `node` not true, an `if` on the job or a job it needs,
   *  or triggers that never run it. Null: on. */
  off: string | null;
}

const CALLS = /^DrDustinEdwards\/devkit\/\.github\/workflows\/(pr|no-bloat)\.yml@/i;

/** Why the workflow's triggers never run its no-bloat caller, or null: pr.yml is the pull request check, so it needs a
 *  pull_request trigger that no path, branch or type filter empties; no-bloat.yml runs on pull requests or a schedule. */
function triggersOff(on: unknown, workflow: "pr" | "no-bloat"): string | null {
  const events: Record<string, unknown> =
    typeof on === "string"
      ? { [on]: null }
      : Array.isArray(on)
        ? Object.fromEntries(on.map((e) => [String(e), null]))
        : isMap(on)
          ? on
          : {};
  const pr = events.pull_request;
  if (!("pull_request" in events))
    return workflow === "no-bloat" && "schedule" in events
      ? null
      : "the workflow does not run on pull requests";
  if (!isMap(pr)) return null;
  for (const key of ["paths", "paths-ignore", "branches-ignore"])
    if (key in pr) return `its pull_request trigger filters ${key}`;
  const branches = pr.branches;
  if (
    Array.isArray(branches) &&
    !branches.some((b) => ["main", "master", "**", "*"].includes(String(b)))
  )
    return `its pull_request trigger runs only for branches ${JSON.stringify(branches)}`;
  const types = pr.types;
  if (Array.isArray(types) && !["opened", "synchronize"].every((t) => types.includes(t)))
    return `its pull_request trigger runs only on ${JSON.stringify(types)}`;
  return null;
}

/** Each job in one workflow file that calls devkit's pr.yml or no-bloat.yml, read as YAML the way devkit's no-bloat bin
 *  reads it (workflowInputs): a pull request that turns the check off is refused there, and this is the nightly look at
 *  what merged. A file that names a caller and does not parse runs nothing. */
export function noBloatJobs(text: string): NoBloatJob[] {
  const doc = readYaml(text);
  if (doc instanceof Error)
    return /DrDustinEdwards\/devkit\/\.github\/workflows\/(?:pr|no-bloat)\.ya?ml/i.test(text)
      ? [
          {
            job: "(file)",
            workflow: "pr",
            off: `the workflow does not parse as YAML (${doc.message.split("\n")[0]})`,
          },
        ]
      : [];
  const jobs = isMap(doc.jobs) ? doc.jobs : {};
  const out: NoBloatJob[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!isMap(job)) continue;
    const m = typeof job.uses === "string" ? CALLS.exec(job.uses.trim()) : null;
    if (!m) continue;
    const workflow = m[1].toLowerCase() as "pr" | "no-bloat";
    const why = (): string | null => {
      if (job.if !== undefined) return `the job "${id}" runs only if ${String(job.if)}`;
      const inputs = isMap(job.with)
        ? Object.fromEntries(Object.entries(job.with).map(([k, v]) => [k.toLowerCase(), v]))
        : {};
      if (workflow === "pr")
        for (const input of ["no-bloat", "node"])
          if (input in inputs && inputs[input] !== true && inputs[input] !== "true")
            return `the job "${id}" passes ${input}: ${String(inputs[input])}`;
      // A job it waits for that is skipped skips it too.
      const seen = new Set<string>();
      const walk = (j: string): string | null => {
        const n = (jobs[j] as Record<string, unknown> | undefined)?.needs;
        for (const d of typeof n === "string" ? [n] : Array.isArray(n) ? n : []) {
          if (typeof d !== "string" || seen.has(d)) continue;
          seen.add(d);
          const dep = jobs[d];
          if (isMap(dep) && dep.if !== undefined)
            return `the job "${id}" waits for "${d}", which runs only if ${String(dep.if)}`;
          const deeper = walk(d);
          if (deeper) return deeper;
        }
        return null;
      };
      const waits = walk(id);
      if (waits) return waits;
      const triggers = triggersOff(doc.on, workflow);
      return triggers ? `the job "${id}" never runs: ${triggers}` : null;
    };
    out.push({ job: id, workflow, off: why() });
  }
  return out;
}
