import type { Env } from "./env";
import { ghFetch } from "./github/client";
import type { OpsPackageConfig, PackageSnapshot, PortalPackageHistory } from "./ops-types";
import { auditStatement } from "./store-guards";

// The packages Capsid Portal watches (job_c6e4ab939a54). Ruling: capsid/decisions.md,
// 2026-09-29, "Portal monitoring is optional and configured per install; packages panel
// approved". Configured like the sites (src/ops-sites.ts): rows in D1 (ops_packages,
// migrations/0028) edited in the Portal's Settings view through the same preview and
// perform. With no row, the watcher reads nothing for packages and the Portal hides the
// Packages view.
//
// Every source below was checked against its own documentation on 2026-09-30, and the
// response shapes against the live endpoints:
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

const PACKAGE_ROWS_LIMIT = 50;
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "capsid-watcher (packages; https://github.com/DrDustinEdwards/capsid)";
// Under npm's 18-month cap on one range query, so no query is silently shortened.
const RANGE_CHUNK_DAYS = 540;
const NPM_FIRST_DAY = "2015-01-10";
// The daily history is fetched on demand and kept this long.
const HISTORY_TTL_SECONDS = 6 * 60 * 60;
export const historyKey = (name: string) => `packages:history:v1:${name}`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---- Configuration ----------------------------------------------------------------------

interface PackageRow {
  name: string;
  registry: string;
  repo: string | null;
  formerly: string | null;
  revision: number;
  updated_at: string;
}

const PACKAGE_COLUMNS = "name, registry, repo, formerly, revision, updated_at";

function configFrom(row: PackageRow): OpsPackageConfig {
  return { name: row.name, registry: "npm", repo: row.repo, formerly: row.formerly, revision: row.revision, updated_at: row.updated_at };
}

/** Every configured package, by name. */
export async function readPackageConfig(db: D1Database): Promise<OpsPackageConfig[]> {
  const { results } = await db.prepare(`SELECT ${PACKAGE_COLUMNS} FROM ops_packages ORDER BY name LIMIT ?1`).bind(PACKAGE_ROWS_LIMIT).all<PackageRow>();
  return (results ?? []).map(configFrom);
}

/** One row, or null. */
export async function readPackageRow(db: D1Database, name: string): Promise<OpsPackageConfig | null> {
  const row = await db.prepare(`SELECT ${PACKAGE_COLUMNS} FROM ops_packages WHERE name = ?1`).bind(name).first<PackageRow>();
  return row ? configFrom(row) : null;
}

export interface PackageInput {
  name: string;
  repo: string | null;
  formerly: string | null;
}

// npm's rules for a new name: at most 214 characters, lowercase, URL-safe, a scope only
// as @scope/name, and no leading dot or underscore.
const UNSCOPED = /^[a-z0-9-~][a-z0-9-._~]*$/;
const SCOPED = /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/;
const REPO_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

function nameRefusal(field: string, value: string): string | null {
  if (value.length > 214) return `${field} is longer than npm's 214 characters.`;
  if (!UNSCOPED.test(value) && !SCOPED.test(value)) return `${field} '${value}' is not an npm package name: lowercase letters, digits and - . _ ~, or @scope/name.`;
  return null;
}

export type ValidatedPackage = { ok: true; pkg: PackageInput } | { ok: false; refusal: string };

export function validatePackage(p: Record<string, string | undefined>): ValidatedPackage {
  const name = (p.name ?? "").trim();
  if (!name) return { ok: false, refusal: "a package needs its npm name." };
  const bad = nameRefusal("the name", name);
  if (bad) return { ok: false, refusal: bad };
  const repo = (p.repo ?? "").trim() || null;
  if (repo !== null && !REPO_SHAPE.test(repo)) return { ok: false, refusal: `the repository '${repo}' is not owner/name on GitHub.` };
  const formerly = (p.formerly ?? "").trim() || null;
  if (formerly !== null) {
    const badFormer = nameRefusal("the former name", formerly);
    if (badFormer) return { ok: false, refusal: badFormer };
    if (formerly === name) return { ok: false, refusal: "the former name is the name itself." };
  }
  return { ok: true, pkg: { name, repo, formerly } };
}

export function describePackage(p: PackageInput): string {
  return `npm "${p.name}"${p.repo ? `, repository ${p.repo}` : ", no repository"}${p.formerly ? `, formerly "${p.formerly}"` : ""}`;
}

export type PackageResult = { ok: true; pkg: OpsPackageConfig } | { ok: false; refusal: string };

/** Add a row. A package already configured is refused, not replaced. */
export async function addPackage(db: D1Database, actor: string, p: PackageInput): Promise<PackageResult> {
  const won = await db
    .prepare("INSERT INTO ops_packages (name, repo, formerly) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING RETURNING name")
    .bind(p.name, p.repo, p.formerly)
    .first<{ name: string }>();
  if (!won) return { ok: false, refusal: `${p.name} is already configured. Edit it instead.` };
  const after = await readPackageRow(db, p.name);
  if (!after) return { ok: false, refusal: `${p.name} was added and then removed before it could be read back.` };
  await db.batch([auditStatement(db, actor, "ops-package-added", null, null, { after })]);
  return { ok: true, pkg: after };
}

/** Replace a row's fields, only if it is still at `revision`. */
export async function editPackage(db: D1Database, actor: string, p: PackageInput, revision: number): Promise<PackageResult> {
  const before = await readPackageRow(db, p.name);
  if (!before) return { ok: false, refusal: `${p.name} is not configured. Add it instead.` };
  const won = await db
    .prepare(
      `UPDATE ops_packages SET repo = ?3, formerly = ?4, revision = revision + 1, updated_at = datetime('now')
       WHERE name = ?1 AND revision = ?2 RETURNING revision`
    )
    .bind(p.name, revision, p.repo, p.formerly)
    .first<{ revision: number }>();
  if (!won) return { ok: false, refusal: `${p.name} changed since the preview (it is at revision ${before.revision}, the preview read ${revision}). Preview again.` };
  const after = await readPackageRow(db, p.name);
  if (!after) return { ok: false, refusal: `${p.name} was edited and then removed before it could be read back.` };
  await db.batch([auditStatement(db, actor, "ops-package-edited", null, null, { before, after })]);
  // A changed name source makes the cached history wrong; the next view refetches.
  return { ok: true, pkg: after };
}

/** Remove a row, only if it is still at `revision`. Its weekly rows stay, as history. */
export async function removePackage(db: D1Database, actor: string, name: string, revision: number): Promise<PackageResult> {
  const before = await readPackageRow(db, name);
  if (!before) return { ok: false, refusal: `${name} is not configured.` };
  const won = await db.prepare("DELETE FROM ops_packages WHERE name = ?1 AND revision = ?2 RETURNING name").bind(name, revision).first<{ name: string }>();
  if (!won) return { ok: false, refusal: `${name} changed since the preview (it is at revision ${before.revision}, the preview read ${revision}). Preview again.` };
  await db.batch([auditStatement(db, actor, "ops-package-removed", null, null, { before })]);
  return { ok: true, pkg: before };
}

// ---- Reading a package, once per watcher pass ------------------------------------------

// A scoped name travels in a path with its slash escaped, which the registry and the
// per-version endpoint require and the download counts accept.
const pathName = (name: string) => name.replace("/", "%2F");

type Got = { ok: true; status: number; json: unknown } | { ok: false; status: number | null; reason: string };

async function getJson(fetchImpl: FetchLike, url: string, accept = "application/json"): Promise<Got> {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, status: res.status, reason: `${new URL(url).host} answered ${res.status}` };
    }
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    return { ok: false, status: null, reason: `${new URL(url).host} could not be read: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}` };
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function readNpm(fetchImpl: FetchLike, name: string): Promise<PackageSnapshot["npm"]> {
  const got = await getJson(fetchImpl, `https://registry.npmjs.org/${pathName(name)}`, "application/vnd.npm.install-v1+json");
  if (!got.ok) return got.status === 404 ? { state: "none", reason: `npm has no package ${name}` } : { state: "error", reason: got.reason };
  const doc = got.json as { "dist-tags"?: Record<string, unknown>; versions?: Record<string, unknown>; modified?: unknown };
  const tags = Object.fromEntries(Object.entries(doc["dist-tags"] ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
  return {
    state: "ok",
    latest: tags.latest ?? null,
    dist_tags: tags,
    versions: Object.keys(doc.versions ?? {}).length,
    modified: typeof doc.modified === "string" ? doc.modified : null,
  };
}

async function readDownloads(fetchImpl: FetchLike, name: string): Promise<PackageSnapshot["downloads"]> {
  const point = async (period: string) => {
    const got = await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/${period}/${name}`);
    // No counts yet is zero downloads, not a failure (npm answers 404 "not found").
    if (!got.ok) return got.status === 404 ? { downloads: 0, end: null } : got.reason;
    const body = got.json as { downloads?: unknown; end?: unknown };
    const downloads = num(body.downloads);
    return downloads === null ? `api.npmjs.org sent no count for ${period}` : { downloads, end: typeof body.end === "string" ? body.end : null };
  };
  const week = await point("last-week");
  if (typeof week === "string") return { state: "error", reason: week };
  const month = await point("last-month");
  if (typeof month === "string") return { state: "error", reason: month };
  const byVersion: Record<string, number> = {};
  const versions = await getJson(fetchImpl, `https://api.npmjs.org/versions/${pathName(name)}/last-week`);
  if (versions.ok) {
    for (const [v, n] of Object.entries((versions.json as { downloads?: Record<string, unknown> }).downloads ?? {})) {
      const count = num(n);
      if (count !== null) byVersion[v] = count;
    }
  } else if (versions.status !== 404) {
    return { state: "error", reason: versions.reason };
  }
  return { state: "ok", last_week: week.downloads, last_month: month.downloads, through: week.end ?? month.end, by_version_last_week: byVersion };
}

async function readDependents(fetchImpl: FetchLike, name: string): Promise<PackageSnapshot["dependents"]> {
  const pkg = await getJson(fetchImpl, `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(name)}`);
  if (!pkg.ok) return pkg.status === 404 ? { state: "none", reason: `deps.dev has no record of ${name} yet` } : { state: "error", reason: pkg.reason };
  const versions = (pkg.json as { versions?: Array<{ versionKey?: { version?: unknown }; isDefault?: unknown }> }).versions ?? [];
  const chosen = versions.find((v) => v.isDefault === true)?.versionKey?.version;
  if (typeof chosen !== "string") return { state: "none", reason: `deps.dev names no default version of ${name}` };
  const got = await getJson(fetchImpl, `https://api.deps.dev/v3alpha/systems/npm/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(chosen)}:dependents`);
  // deps.dev answers 404 "dependents not found" for a version nothing depends on.
  if (!got.ok) return got.status === 404 ? { state: "none", reason: `deps.dev knows no package that depends on ${name}@${chosen}` } : { state: "error", reason: got.reason };
  const c = got.json as { dependentCount?: unknown; directDependentCount?: unknown; indirectDependentCount?: unknown };
  const total = num(c.dependentCount);
  if (total === null) return { state: "error", reason: "deps.dev sent no dependentCount" };
  return { state: "ok", version: chosen, direct: num(c.directDependentCount) ?? 0, indirect: num(c.indirectDependentCount) ?? 0, total };
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
    return { ok: false, status: null, reason: `GitHub could not be read: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}` };
  }
}

async function readGithub(env: Env, repo: string | null): Promise<PackageSnapshot["github"]> {
  if (!repo) return { state: "none", reason: "no repository is configured for this package" };
  const [owner, name] = repo.split("/");
  const r = await ghJson(env, owner, name, `/repos/${owner}/${name}`);
  if (!r.ok) return { state: "error", reason: r.reason };
  const info = r.json as { stargazers_count?: unknown; open_issues_count?: unknown };
  const pulls = await ghJson(env, owner, name, `/repos/${owner}/${name}/pulls?state=open&per_page=100`);
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
    latest_release: rel && typeof rel.tag_name === "string" ? { tag: rel.tag_name, published_at: typeof rel.published_at === "string" ? rel.published_at : null } : null,
  };
}

/** One package, as one watcher pass reads it: nine requests at most, sequential, each
 *  failing on its own so one unreachable source does not blank the others. */
export async function readPackage(env: Env, cfg: OpsPackageConfig, fetchImpl: FetchLike, now: Date): Promise<PackageSnapshot> {
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

/** "2026-W40": the ISO 8601 week `d` falls in. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The week's GitHub numbers, written once: the first pass of each ISO week that read
 *  the repository keeps its row, and later passes that week change nothing. */
export function weekStatement(db: D1Database, snap: PackageSnapshot, now: Date): D1PreparedStatement | null {
  const g = snap.github;
  if (g.state !== "ok") return null;
  return db
    .prepare(
      `INSERT INTO ops_package_weeks (name, week, repo, stars, open_issues, open_prs, latest_release)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (name, week) DO NOTHING`
    )
    .bind(snap.name, isoWeek(now), g.repo, g.stars, g.open_issues, g.open_prs, g.latest_release?.tag ?? null);
}

// ---- The daily history, on demand ------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

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
    const chunkEnd = new Date(Math.min(start.getTime() + (RANGE_CHUNK_DAYS - 1) * DAY_MS, end.getTime()));
    out.push([dayOf(start), dayOf(chunkEnd)]);
    start = new Date(chunkEnd.getTime() + DAY_MS);
  }
  return out;
}

async function dailyDownloads(fetchImpl: FetchLike, name: string, now: Date, notes: string[]): Promise<Array<{ day: string; downloads: number; name: string }>> {
  const first = await firstPublished(fetchImpl, name);
  if (!first) notes.push(`npm did not say when ${name} was first published, so its history is read from ${NPM_FIRST_DAY}, the first day npm counted.`);
  const from = first && first > NPM_FIRST_DAY ? first : NPM_FIRST_DAY;
  // npm counts each day after UTC midnight; yesterday is the newest it may have.
  const to = dayOf(new Date(now.getTime() - DAY_MS));
  const days: Array<{ day: string; downloads: number; name: string }> = [];
  for (const [a, b] of historyRanges(from, to)) {
    const got = await getJson(fetchImpl, `https://api.npmjs.org/downloads/range/${a}:${b}/${name}`);
    if (!got.ok) {
      if (got.status !== 404) notes.push(`${name}, ${a} to ${b}: ${got.reason}; those days are missing, not zero.`);
      continue;
    }
    for (const d of (got.json as { downloads?: Array<{ day?: unknown; downloads?: unknown }> }).downloads ?? []) {
      const n = num(d.downloads);
      if (typeof d.day === "string" && n !== null && n > 0) days.push({ day: d.day, downloads: n, name });
    }
  }
  return days;
}

/** The package's daily downloads, and its former name's, oldest first, with its weekly
 *  GitHub rows. Cached for HISTORY_TTL_SECONDS under historyKey. */
export async function packageHistory(env: Env, cfg: OpsPackageConfig, fetchImpl: FetchLike, now: Date): Promise<PortalPackageHistory> {
  const weeks = await env.DB.prepare(
    "SELECT week, stars, open_issues, open_prs, latest_release FROM ops_package_weeks WHERE name = ?1 ORDER BY week DESC LIMIT 104"
  )
    .bind(cfg.name)
    .all<PortalPackageHistory["weeks"][number]>();
  const key = historyKey(cfg.name);
  let cached: { formerly: string | null; fetched_at: string; days: PortalPackageHistory["days"]; notes: string[] } | null = null;
  try {
    const raw = await env.APP_KV.get(key);
    cached = raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`PACKAGES_HISTORY_CACHE_UNREADABLE ${key}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A cache written before the former name changed is not this package's history.
  if (!cached || cached.formerly !== cfg.formerly) {
    const notes: string[] = [];
    const days = [...(cfg.formerly ? await dailyDownloads(fetchImpl, cfg.formerly, now, notes) : []), ...(await dailyDownloads(fetchImpl, cfg.name, now, notes))];
    days.sort((a, b) => (a.day === b.day ? a.name.localeCompare(b.name) : a.day < b.day ? -1 : 1));
    cached = { formerly: cfg.formerly, fetched_at: now.toISOString(), days, notes };
    await env.APP_KV.put(key, JSON.stringify(cached), { expirationTtl: HISTORY_TTL_SECONDS });
  }
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

