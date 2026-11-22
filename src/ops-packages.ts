import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import type { Env } from "./env";
import { ghFetch } from "./github/client";
import type { OpsPackageConfig, PackageSnapshot, PortalPackageHistory } from "./ops-types/sites";
import { errorMessage } from "@dustinedwards/site-runtime/log";
import { DAY_MS, isoWeek, utcDay } from "./time";
import { callSignal } from "./call-signal";

// The packages Capsid Portal watches Configured like the sites (src/ops-sites.ts): rows in D1 (ops_packages,
// migrations/0028) edited in the Portal's Settings view through the same preview and
// perform. With no row, the watcher reads nothing for packages and the Portal hides the
// Packages view.
//
// Source shapes, from each one's documentation:
//   registry.npmjs.org/<name> with Accept: application/vnd.npm.install-v1+json, the
//     abbreviated document: dist-tags, versions, modified; no time object
//     (github.com/npm/registry, docs/responses/package-metadata.md).
//   api.npmjs.org/downloads/point/{last-week,last-month}/<name> and
//     /downloads/range/<start>:<end>/<name>: "at most 18 months of data" per query
//     (the API moves a longer range's start forward rather than refusing it), counted
//     "daily after UTC midnight", nothing before 2015-01-10. A package npm has no counts
//     for yet answers 404 "not found", which is zero, not a failure. /versions/<name>/
//     last-week is per version for the last 7 days and nothing else
//     (docs/download-counts.md). No rate limit is published for either host; npm has
//     said anonymous callers may see 429.
//   api.deps.dev/v3/systems/npm/packages/<name> for the default version, then
//     /v3alpha/.../versions/<v>:dependents: counts of "distinct packages known to depend
//     on a given package version, either directly or indirectly", "indicative of
//     relative popularity rather than precisely accurate", and an alpha endpoint that
//     "may change". It returns counts, not a list: no documented public API lists an
//     npm package's dependents, and GitHub has no API for "Used by". So the panel links
//     to npmjs.com's and deps.dev's pages for the list rather than inventing one.
//   GitHub, through the App: stars and open_issues_count from /repos/<o>/<r> (which
//     counts pull requests as issues, so the open pull requests are subtracted), open
//     pull requests from /pulls?state=open (one page of 100: more is reported as 100
//     and marked capped), the latest release from /releases/latest (404 when none).

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "capsid-watcher (packages; https://github.com/DrDustinEdwards/capsid)";
// Under npm's 18-month cap on one range query, so no query is silently shortened.
const RANGE_CHUNK_DAYS = 540;
const NPM_FIRST_DAY = "2015-01-10";
// The daily history is fetched on demand and kept this long.
const HISTORY_TTL_SECONDS = 6 * 60 * 60;
export const historyKey = (name: string) => `packages:history:v1:${name}`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// A scoped name travels in a path with its slash escaped, which the registry and the
// per-version endpoint require and the download counts accept.
const pathName = (name: string) => name.replace("/", "%2F");

type Got =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number | null; reason: string };

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  accept = "application/json",
): Promise<Got> {
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: callSignal(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return {
        ok: false,
        status: res.status,
        reason: `${new URL(url).host} answered ${res.status}`,
      };
    }
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    return {
      ok: false,
      status: null,
      reason: `${new URL(url).host} could not be read: ${errorMessage(err).slice(0, 160)}`,
    };
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The versions npm has published for `name`, or null when npm has no such package. A
 *  failed read throws, so a caller cannot read it as "not published". For a blocked
 *  job's "check: npm <name>@<version>" line (src/manual-steps.ts) and the job body fact
 *  check (src/job-fact-check.ts). */
export async function npmVersions(fetchImpl: FetchLike, name: string): Promise<string[] | null> {
  const got = await getJson(
    fetchImpl,
    `https://registry.npmjs.org/${pathName(name)}`,
    "application/vnd.npm.install-v1+json",
  );
  if (!got.ok) {
    if (got.status === 404) return null;
    throw new Error(got.reason);
  }
  return Object.keys((got.json as { versions?: Record<string, unknown> }).versions ?? {});
}

// Also read by the Shared code view (src/shared-code.ts), for each shared package that is
// not private, so it can say whether the version in the repo has reached npm.
export async function readNpm(fetchImpl: FetchLike, name: string): Promise<PackageSnapshot["npm"]> {
  const got = await getJson(
    fetchImpl,
    `https://registry.npmjs.org/${pathName(name)}`,
    "application/vnd.npm.install-v1+json",
  );
  if (!got.ok)
    return got.status === 404
      ? { state: "none", reason: `npm has no package ${name}` }
      : { state: "error", reason: got.reason };
  const doc = got.json as {
    "dist-tags"?: Record<string, unknown>;
    versions?: Record<string, unknown>;
    modified?: unknown;
  };
  const tags = Object.fromEntries(
    Object.entries(doc["dist-tags"] ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  return {
    state: "ok",
    latest: tags.latest ?? null,
    dist_tags: tags,
    versions: Object.keys(doc.versions ?? {}).length,
    modified: typeof doc.modified === "string" ? doc.modified : null,
  };
}

/** Every version npm has published of `name`, for the versions model's "behind" count
 *  (src/shared-code.ts). The same abbreviated document readNpm reads; throws with npm's
 *  answer when it cannot be read. */
export async function readNpmVersions(fetchImpl: FetchLike, name: string): Promise<string[]> {
  const got = await getJson(
    fetchImpl,
    `https://registry.npmjs.org/${pathName(name)}`,
    "application/vnd.npm.install-v1+json",
  );
  if (!got.ok) throw new Error(got.status === 404 ? `npm has no package ${name}` : got.reason);
  return Object.keys((got.json as { versions?: Record<string, unknown> }).versions ?? {});
}

async function readDownloads(
  fetchImpl: FetchLike,
  name: string,
): Promise<PackageSnapshot["downloads"]> {
  const point = async (period: string) => {
    const got = await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/${period}/${name}`);
    // No counts yet is zero downloads, not a failure (npm answers 404 "not found").
    if (!got.ok) return got.status === 404 ? { downloads: 0, end: null } : got.reason;
    const body = got.json as { downloads?: unknown; end?: unknown };
    const downloads = num(body.downloads);
    return downloads === null
      ? `api.npmjs.org sent no count for ${period}`
      : { downloads, end: typeof body.end === "string" ? body.end : null };
  };
  const week = await point("last-week");
  if (typeof week === "string") return { state: "error", reason: week };
  const month = await point("last-month");
  if (typeof month === "string") return { state: "error", reason: month };
  const byVersion: Record<string, number> = {};
  const versions = await getJson(
    fetchImpl,
    `https://api.npmjs.org/versions/${pathName(name)}/last-week`,
  );
  if (versions.ok) {
    for (const [v, n] of Object.entries(
      (versions.json as { downloads?: Record<string, unknown> }).downloads ?? {},
    )) {
      const count = num(n);
      if (count !== null) byVersion[v] = count;
    }
  } else if (versions.status !== 404) {
    return { state: "error", reason: versions.reason };
  }
  return {
    state: "ok",
    last_week: week.downloads,
    last_month: month.downloads,
    through: week.end ?? month.end,
    by_version_last_week: byVersion,
  };
}

async function readDependents(
  fetchImpl: FetchLike,
  name: string,
): Promise<PackageSnapshot["dependents"]> {
  const pkg = await getJson(
    fetchImpl,
    `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(name)}`,
  );
  if (!pkg.ok)
    return pkg.status === 404
      ? { state: "none", reason: `deps.dev has no record of ${name} yet` }
      : { state: "error", reason: pkg.reason };
  const versions =
    (pkg.json as { versions?: Array<{ versionKey?: { version?: unknown }; isDefault?: unknown }> })
      .versions ?? [];
  const chosen = versions.find((v) => v.isDefault === true)?.versionKey?.version;
  if (typeof chosen !== "string")
    return { state: "none", reason: `deps.dev names no default version of ${name}` };
  const got = await getJson(
    fetchImpl,
    `https://api.deps.dev/v3alpha/systems/npm/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(chosen)}:dependents`,
  );
  // deps.dev answers 404 "dependents not found" for a version nothing depends on.
  if (!got.ok)
    return got.status === 404
      ? { state: "none", reason: `deps.dev knows no package that depends on ${name}@${chosen}` }
      : { state: "error", reason: got.reason };
  const c = got.json as {
    dependentCount?: unknown;
    directDependentCount?: unknown;
    indirectDependentCount?: unknown;
  };
  const total = num(c.dependentCount);
  if (total === null) return { state: "error", reason: "deps.dev sent no dependentCount" };
  return {
    state: "ok",
    version: chosen,
    direct: num(c.directDependentCount) ?? 0,
    indirect: num(c.indirectDependentCount) ?? 0,
    total,
  };
}

async function ghJson(env: Env, owner: string, repo: string, path: string): Promise<Got> {
  try {
    const res = await ghFetch(env, owner, repo, path);
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status, reason: `GitHub answered ${res.status} for ${path}` };
    }
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    return {
      ok: false,
      status: null,
      reason: `GitHub could not be read: ${errorMessage(err).slice(0, 160)}`,
    };
  }
}

async function readGithub(env: Env, repo: string | null): Promise<PackageSnapshot["github"]> {
  if (!repo) return { state: "none", reason: "no repository is configured for this package" };
  const [owner, name] = repo.split("/");
  const r = await ghJson(env, owner, name, `/repos/${owner}/${name}`);
  if (!r.ok) return { state: "error", reason: r.reason };
  const info = r.json as { stargazers_count?: unknown; open_issues_count?: unknown };
  const pulls = await ghJson(
    env,
    owner,
    name,
    `/repos/${owner}/${name}/pulls?state=open&per_page=100`,
  );
  if (!pulls.ok) return { state: "error", reason: pulls.reason };
  const openPrs = Array.isArray(pulls.json) ? pulls.json.length : 0;
  const release = await ghJson(env, owner, name, `/repos/${owner}/${name}/releases/latest`);
  if (!release.ok && release.status !== 404) return { state: "error", reason: release.reason };
  const rel = release.ok ? (release.json as { tag_name?: unknown; published_at?: unknown }) : null;
  const openIssuesAndPrs = num(info.open_issues_count) ?? 0;
  return {
    state: "ok",
    repo,
    stars: num(info.stargazers_count) ?? 0,
    // GitHub's open_issues_count includes open pull requests.
    open_issues: Math.max(0, openIssuesAndPrs - openPrs),
    open_prs: openPrs,
    open_prs_capped: openPrs >= 100,
    latest_release:
      rel && typeof rel.tag_name === "string"
        ? {
            tag: rel.tag_name,
            published_at: typeof rel.published_at === "string" ? rel.published_at : null,
          }
        : null,
  };
}

/** One package, as one watcher pass reads it: nine requests at most, sequential, each
 *  failing on its own so one unreachable source does not blank the others. */
export async function readPackage(
  env: Env,
  cfg: OpsPackageConfig,
  fetchImpl: FetchLike,
  now: Date,
): Promise<PackageSnapshot> {
  return {
    name: cfg.name,
    registry: "npm",
    at: now.toISOString(),
    npm: await readNpm(fetchImpl, cfg.name),
    downloads: await readDownloads(fetchImpl, cfg.name),
    dependents: await readDependents(fetchImpl, cfg.name),
    github: await readGithub(env, cfg.repo),
  };
}

/** The week's GitHub numbers, written once: the first pass of each ISO week that read
 *  the repository keeps its row, and later passes that week change nothing. */
export function weekStatement(
  db: D1Database,
  snap: PackageSnapshot,
  now: Date,
): D1PreparedStatement | null {
  const g = snap.github;
  if (g.state !== "ok") return null;
  return db
    .prepare(
      `INSERT INTO ops_package_weeks (name, week, repo, stars, open_issues, open_prs, latest_release)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (name, week) DO NOTHING`,
    )
    .bind(
      snap.name,
      isoWeek(now),
      g.repo,
      g.stars,
      g.open_issues,
      g.open_prs,
      g.latest_release?.tag ?? null,
    );
}

/** When npm first published `name`, from the full document's time.created (the
 *  abbreviated one has no time object). An unpublished package keeps its document and
 *  its created time, so a former name still has a start. */
async function firstPublished(fetchImpl: FetchLike, name: string): Promise<string | null> {
  const got = await getJson(fetchImpl, `https://registry.npmjs.org/${pathName(name)}`);
  if (!got.ok) return null;
  const created = (got.json as { time?: { created?: unknown } }).time?.created;
  return typeof created === "string" ? created.slice(0, 10) : null;
}

/** The ranges, oldest first, that cover `from` to `to` in chunks npm will not shorten. */
export function historyRanges(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = new Date(
      Math.min(start.getTime() + (RANGE_CHUNK_DAYS - 1) * DAY_MS, end.getTime()),
    );
    out.push([utcDay(start), utcDay(chunkEnd)]);
    start = new Date(chunkEnd.getTime() + DAY_MS);
  }
  return out;
}

async function dailyDownloads(
  fetchImpl: FetchLike,
  name: string,
  now: Date,
  notes: string[],
): Promise<Array<{ day: string; downloads: number; name: string }>> {
  const first = await firstPublished(fetchImpl, name);
  if (!first)
    notes.push(
      `npm did not say when ${name} was first published, so its history is read from ${NPM_FIRST_DAY}, the first day npm counted.`,
    );
  const from = first && first > NPM_FIRST_DAY ? first : NPM_FIRST_DAY;
  // npm counts each day after UTC midnight; yesterday is the newest it may have.
  const to = utcDay(new Date(now.getTime() - DAY_MS));
  const days: Array<{ day: string; downloads: number; name: string }> = [];
  for (const [a, b] of historyRanges(from, to)) {
    const got = await getJson(fetchImpl, `https://api.npmjs.org/downloads/range/${a}:${b}/${name}`);
    if (!got.ok) {
      if (got.status !== 404)
        notes.push(`${name}, ${a} to ${b}: ${got.reason}; those days are missing, not zero.`);
      continue;
    }
    for (const d of (got.json as { downloads?: Array<{ day?: unknown; downloads?: unknown }> })
      .downloads ?? []) {
      const n = num(d.downloads);
      if (typeof d.day === "string" && n !== null && n > 0)
        days.push({ day: d.day, downloads: n, name });
    }
  }
  return days;
}

/** The package's daily downloads, and its former name's, oldest first, with its weekly
 *  GitHub rows. Cached for HISTORY_TTL_SECONDS under historyKey. */
export async function packageHistory(
  env: Env,
  cfg: OpsPackageConfig,
  fetchImpl: FetchLike,
  now: Date,
): Promise<PortalPackageHistory> {
  const weeks = await env.DB.prepare(
    "SELECT week, stars, open_issues, open_prs, latest_release FROM ops_package_weeks WHERE name = ?1 ORDER BY week DESC LIMIT 104",
  )
    .bind(cfg.name)
    .all<PortalPackageHistory["weeks"][number]>();
  const key = historyKey(cfg.name);
  // A kept history written before the former name changed is not this package's history.
  const cached = await kvCached(
    env.APP_KV,
    key,
    {
      ttl: HISTORY_TTL_SECONDS,
      valid: (kept) => kept !== null && (kept as { formerly?: unknown }).formerly === cfg.formerly,
    },
    async () => {
      const notes: string[] = [];
      const days = [
        ...(cfg.formerly ? await dailyDownloads(fetchImpl, cfg.formerly, now, notes) : []),
        ...(await dailyDownloads(fetchImpl, cfg.name, now, notes)),
      ];
      days.sort((x, y) =>
        x.day === y.day ? x.name.localeCompare(y.name) : x.day < y.day ? -1 : 1,
      );
      return { formerly: cfg.formerly, fetched_at: now.toISOString(), days, notes };
    },
  );
  return {
    name: cfg.name,
    formerly: cfg.formerly,
    generated: now.toISOString(),
    fetched_at: cached.fetched_at,
    days: cached.days,
    first_day: cached.days[0]?.day ?? null,
    last_day: cached.days[cached.days.length - 1]?.day ?? null,
    notes: cached.notes,
    weeks: weeks.results ?? [],
  };
}
