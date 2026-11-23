import type { OpsPackageConfig } from "./ops-types/sites";
import { auditCommitted } from "./store-guards";

// The packages configuration: the ops_packages rows and their validated edits.

const PACKAGE_ROWS_LIMIT = 50;

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
  return {
    name: row.name,
    registry: "npm",
    repo: row.repo,
    formerly: row.formerly,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

/** Every configured package, by name. */
export async function readPackageConfig(db: D1Database): Promise<OpsPackageConfig[]> {
  const { results } = await db
    .prepare(`SELECT ${PACKAGE_COLUMNS} FROM ops_packages ORDER BY name LIMIT ?1`)
    .bind(PACKAGE_ROWS_LIMIT)
    .all<PackageRow>();
  return (results ?? []).map(configFrom);
}

/** One row, or null. */
export async function readPackageRow(
  db: D1Database,
  name: string,
): Promise<OpsPackageConfig | null> {
  const row = await db
    .prepare(`SELECT ${PACKAGE_COLUMNS} FROM ops_packages WHERE name = ?1`)
    .bind(name)
    .first<PackageRow>();
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
  if (!UNSCOPED.test(value) && !SCOPED.test(value))
    return `${field} '${value}' is not an npm package name: lowercase letters, digits and - . _ ~, or @scope/name.`;
  return null;
}

export type ValidatedPackage = { ok: true; pkg: PackageInput } | { ok: false; refusal: string };

export function validatePackage(p: Record<string, string | undefined>): ValidatedPackage {
  const name = (p.name ?? "").trim();
  if (!name) return { ok: false, refusal: "a package needs its npm name." };
  const bad = nameRefusal("the name", name);
  if (bad) return { ok: false, refusal: bad };
  const repo = (p.repo ?? "").trim() || null;
  if (repo !== null && !REPO_SHAPE.test(repo))
    return { ok: false, refusal: `the repository '${repo}' is not owner/name on GitHub.` };
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

export type PackageResult =
  | { ok: true; pkg: OpsPackageConfig; warning?: string }
  | { ok: false; refusal: string };

/** Add a row. A package already configured is refused, not replaced. */
export async function addPackage(
  db: D1Database,
  actor: string,
  p: PackageInput,
): Promise<PackageResult> {
  const won = await db
    .prepare(
      "INSERT INTO ops_packages (name, repo, formerly) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING RETURNING name",
    )
    .bind(p.name, p.repo, p.formerly)
    .first<{ name: string }>();
  if (!won) return { ok: false, refusal: `${p.name} is already configured. Edit it instead.` };
  const after = await readPackageRow(db, p.name);
  if (!after)
    return {
      ok: false,
      refusal: `${p.name} was added and then removed before it could be read back.`,
    };
  const warning = await auditCommitted(db, actor, "ops-package-added", null, { after });
  return { ok: true, pkg: after, warning };
}

/** Replace a row's fields, only if it is still at `revision`. */
export async function editPackage(
  db: D1Database,
  actor: string,
  p: PackageInput,
  revision: number,
): Promise<PackageResult> {
  const before = await readPackageRow(db, p.name);
  if (!before) return { ok: false, refusal: `${p.name} is not configured. Add it instead.` };
  const won = await db
    .prepare(
      `UPDATE ops_packages SET repo = ?3, formerly = ?4, revision = revision + 1, updated_at = datetime('now')
       WHERE name = ?1 AND revision = ?2 RETURNING revision`,
    )
    .bind(p.name, revision, p.repo, p.formerly)
    .first<{ revision: number }>();
  if (!won)
    return {
      ok: false,
      refusal: `${p.name} changed since the preview (it is at revision ${before.revision}, the preview read ${revision}). Preview again.`,
    };
  const after = await readPackageRow(db, p.name);
  if (!after)
    return {
      ok: false,
      refusal: `${p.name} was edited and then removed before it could be read back.`,
    };
  const warning = await auditCommitted(db, actor, "ops-package-edited", null, { before, after });
  // A changed name source makes the cached history wrong; the next view refetches.
  return { ok: true, pkg: after, warning };
}

/** Remove a row, only if it is still at `revision`. Its weekly rows stay, as history. */
export async function removePackage(
  db: D1Database,
  actor: string,
  name: string,
  revision: number,
): Promise<PackageResult> {
  const before = await readPackageRow(db, name);
  if (!before) return { ok: false, refusal: `${name} is not configured.` };
  const won = await db
    .prepare("DELETE FROM ops_packages WHERE name = ?1 AND revision = ?2 RETURNING name")
    .bind(name, revision)
    .first<{ name: string }>();
  if (!won)
    return {
      ok: false,
      refusal: `${name} changed since the preview (it is at revision ${before.revision}, the preview read ${revision}). Preview again.`,
    };
  const warning = await auditCommitted(db, actor, "ops-package-removed", null, { before });
  return { ok: true, pkg: before, warning };
}
