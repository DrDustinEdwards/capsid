import type { OpsSiteConfig, SiteMapDrift } from "./ops-types";
import { auditStatement } from "./store-guards";
import { parseOperator } from "./site-operator";

// The sites the watcher probes for Capsid Portal (capsid/research/design-ops-console.md),
// read from configuration, not code. Ruling: capsid/decisions.md, 2026-09-29, "Portal
// monitoring is optional and configured per install". The rows live in D1 (ops_sites,
// migrations/0022_ops_sites.sql) and are edited in the Portal's Settings view through
// the same preview and perform as every other control (src/portal-actions.ts). This
// module reads them, validates an edit, and writes one.
//
// A row with an origin is a site. A row with no origin says its namespace serves no
// site, so the site-map drift check can tell a decision from an omission. With no row
// that has an origin, the watcher probes nothing and the Portal hides the Sites view.
//
// Why a table and not one settings record: each row is edited on its own, with a
// guarded UPDATE on its revision, so two edits to different sites cannot overwrite
// each other, and a stale preview of one site is refused without touching the rest.
// The schema holds the platform to two values and the origin and platform to both or
// neither. And the backup dumps every table in TABLES (src/backup.ts), so the
// configuration is in the nightly dump with no extra step.

export interface OpsSite {
  namespace: string;
  name: string;
  origin: string;
  // The site's own health route, or null where it has none; the probe then reads the
  // root, which proves liveness and nothing more.
  healthPath: string | null;
  platform: "cloudflare" | "vercel";
  // The Worker script that serves the site, named only where it is known. Every other
  // Cloudflare site is resolved on each pass from the account's Workers custom domains
  // (src/ops-cloudflare.ts), and one that resolves to nothing is shown as unresolved
  // rather than guessed.
  script?: string;
  // Probed in-process through healthReport() instead of over HTTP: a Worker fetching
  // its own workers.dev hostname is not a reliable probe of itself. Set by the seed for
  // Capsid's own row only; the Portal cannot set it, and an edit that changes the
  // origin clears it.
  self?: true;
}

export type { OpsSiteConfig, SiteMapDrift };

const SITE_PLATFORMS = ["cloudflare", "vercel"] as const;
export type SitePlatform = (typeof SITE_PLATFORMS)[number];

// A bound, not a page: one row per namespace, and namespaces are registered by hand.
const SITE_ROWS_LIMIT = 500;

interface SiteRow {
  namespace: string;
  name: string;
  origin: string | null;
  health_path: string | null;
  platform: SitePlatform | null;
  script: string | null;
  self_probe: number;
  revision: number;
  updated_at: string;
  operator: string | null;
}

const SITE_COLUMNS = "namespace, name, origin, health_path, platform, script, self_probe, revision, updated_at, operator";

function configFrom(row: SiteRow): OpsSiteConfig {
  return {
    namespace: row.namespace,
    name: row.name,
    origin: row.origin,
    health_path: row.health_path,
    platform: row.platform,
    script: row.script,
    self_probe: row.self_probe === 1,
    revision: row.revision,
    updated_at: row.updated_at,
    ...operatorFrom(row.operator),
  };
}

/** The stored operator JSON, parsed by the same rules an edit passes. A stored value that
 *  no longer passes (a ceiling tightened since) is not used, and the reason is shown. */
function operatorFrom(raw: string | null | undefined): Pick<OpsSiteConfig, "operator" | "operator_problem"> {
  if (raw === null || raw === undefined) return { operator: null, operator_problem: null };
  const parsed = parseOperator(raw);
  return parsed.ok ? { operator: parsed.operator, operator_problem: null } : { operator: null, operator_problem: parsed.refusal };
}

/** Every configured row, sites and no-site declarations, by namespace. */
export async function readSiteConfig(db: D1Database): Promise<OpsSiteConfig[]> {
  const { results } = await db.prepare(`SELECT ${SITE_COLUMNS} FROM ops_sites ORDER BY namespace LIMIT ?1`).bind(SITE_ROWS_LIMIT).all<SiteRow>();
  return (results ?? []).map(configFrom);
}

/** The rows that are sites, in the shape the probes and the Cloudflare read take. */
export function sitesFrom(config: readonly OpsSiteConfig[]): OpsSite[] {
  const out: OpsSite[] = [];
  for (const c of config) {
    if (c.origin === null || c.platform === null) continue;
    out.push({
      namespace: c.namespace,
      name: c.name,
      origin: c.origin,
      healthPath: c.health_path,
      platform: c.platform,
      ...(c.script ? { script: c.script } : {}),
      ...(c.self_probe ? { self: true as const } : {}),
    });
  }
  return out;
}

// unmapped: registered, but in no row. unknown: in a row, but not registered.
export function siteMapDrift(registered: readonly string[], config: readonly OpsSiteConfig[]): SiteMapDrift {
  const covered = new Set(config.map((c) => c.namespace));
  const known = new Set(registered);
  return {
    unmapped: registered.filter((ns) => !covered.has(ns)).sort(),
    unknown: [...covered].filter((ns) => !known.has(ns)).sort(),
  };
}

// ---- Validation -------------------------------------------------------------------------

export interface SiteInput {
  namespace: string;
  name: string;
  // null: the namespace serves no site.
  origin: string | null;
  health_path: string | null;
  platform: SitePlatform | null;
  script: string | null;
  // The operator JSON as it will be stored, null to clear it, or undefined to leave an
  // edited row's value as it is (an edit from a form that does not show it).
  operator?: string | null;
}

export type Validated = { ok: true; site: SiteInput } | { ok: false; refusal: string };

const NAMESPACE_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LABEL_SHAPE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SCRIPT_SHAPE = /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/;
// Unreserved URL characters and the separator only: no query, no fragment, no percent
// escape, no space. The probe appends this to the origin as it stands.
const HEALTH_PATH_SHAPE = /^\/[A-Za-z0-9._~\/-]{0,199}$/;
const NAME_MAX = 80;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** A hostname a probe may fetch: lowercase DNS labels, at least two, no IP literal and
 *  no local name. Returns the refusal, or null when it is fine. */
export function hostnameRefusal(host: string): string | null {
  if (host.length === 0 || host.length > 253) return `the hostname '${host}' must be 1 to 253 characters.`;
  if (host !== host.toLowerCase()) return `the hostname '${host}' must be lowercase.`;
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return `'${host}' is an IP address; a site is named by its hostname.`;
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return `'${host}' is a local name, which a probe from Cloudflare cannot reach.`;
  }
  const labels = host.split(".");
  if (labels.length < 2) return `'${host}' is a single-label name; a site needs a public hostname such as example.com.`;
  for (const label of labels) {
    if (!LABEL_SHAPE.test(label)) return `'${label}' in '${host}' is not a hostname label: letters, digits and inner hyphens, 1 to 63 characters.`;
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return `'${host}' ends in a numeric label, which no public hostname does.`;
  return null;
}

/** The origin as https://host, or the refusal. Nothing but a scheme and a host: no
 *  credentials, no port, no path, no query and no fragment. */
export function originFrom(raw: string): { ok: true; origin: string } | { ok: false; refusal: string } {
  const match = /^https:\/\/([^/?#@:]+)\/?$/.exec(raw);
  if (!match) {
    if (!/^https:\/\//i.test(raw)) return { ok: false, refusal: `the origin must start with https://; got '${raw}'.` };
    return {
      ok: false,
      refusal: `the origin is https:// and a hostname only, with no user, port, path, query or fragment; put a health route in the health path. Got '${raw}'.`,
    };
  }
  const host = match[1];
  const bad = hostnameRefusal(host);
  if (bad) return { ok: false, refusal: bad };
  return { ok: true, origin: `https://${host}` };
}

/** The refusal for a health path, or null. Starts with /, unreserved characters only,
 *  no empty or dot segment. */
export function healthPathRefusal(path: string): string | null {
  if (!HEALTH_PATH_SHAPE.test(path)) {
    return `the health path '${path}' must start with / and use only letters, digits and - . _ ~ /, at most 200 characters, with no query or fragment.`;
  }
  const segments = path.split("/").slice(1);
  if (segments.some((s, i) => (s === "" && i < segments.length - 1) || s === "." || s === "..")) {
    return `the health path '${path}' has an empty, '.' or '..' segment.`;
  }
  return null;
}

/** A Portal edit's params, checked and normalized. Blank fields arrive absent. */
export function validateSite(p: Record<string, string | undefined>): Validated {
  const refuse = (refusal: string): Validated => ({ ok: false, refusal });
  const namespace = p.namespace ?? "";
  if (!NAMESPACE_SHAPE.test(namespace)) return refuse(`'${namespace}' is not a namespace name: lowercase letters, digits and hyphens.`);
  const name = p.name ?? namespace;
  if (name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return refuse(`the name must be at most ${NAME_MAX} characters with no control characters.`);

  // operator: absent leaves an edit's stored value alone, "none" clears it, anything else
  // is the JSON, checked whole and stored in its normalized form.
  let operator: string | null | undefined;
  if (p.operator === "none") operator = null;
  else if (p.operator !== undefined) {
    const parsed = parseOperator(p.operator);
    if (!parsed.ok) return refuse(parsed.refusal);
    operator = JSON.stringify(parsed.operator);
  }

  if (!p.origin) {
    if (operator) return refuse("a namespace that serves no site has no operator API.");
    if (p.health_path || p.platform || p.script) {
      return refuse("a namespace that serves no site takes no health path, platform or script. Give an origin to make it a site.");
    }
    return { ok: true, site: { namespace, name, origin: null, health_path: null, platform: null, script: null, operator: null } };
  }
  const origin = originFrom(p.origin);
  if (!origin.ok) return refuse(origin.refusal);
  if (!p.platform || !(SITE_PLATFORMS as readonly string[]).includes(p.platform)) {
    return refuse(`the platform must be one of ${SITE_PLATFORMS.join(", ")}; got '${p.platform ?? ""}'.`);
  }
  const platform = p.platform as SitePlatform;
  if (p.health_path) {
    const bad = healthPathRefusal(p.health_path);
    if (bad) return refuse(bad);
  }
  if (p.script) {
    if (platform !== "cloudflare") return refuse("only a Cloudflare site names a Worker script.");
    if (!SCRIPT_SHAPE.test(p.script)) return refuse(`'${p.script}' is not a Worker script name: lowercase letters, digits, - and _.`);
  }
  return {
    ok: true,
    site: { namespace, name, origin: origin.origin, health_path: p.health_path ?? null, platform, script: p.script ?? null, ...(operator !== undefined ? { operator } : {}) },
  };
}

/** One line for a preview: what the row is. */
export function describeSite(site: Pick<SiteInput, "origin" | "health_path" | "platform" | "script" | "name">): string {
  if (site.origin === null) return `"${site.name}", serves no site (not probed)`;
  const probe = site.health_path ? `${site.origin}${site.health_path}` : `${site.origin}/ (no health route, so the root)`;
  return `"${site.name}", probed at ${probe}, on ${site.platform}${site.script ? `, Worker script ${site.script}` : ""}`;
}

// ---- Writes -----------------------------------------------------------------------------

export type SiteResult = { ok: true; site: OpsSiteConfig } | { ok: false; refusal: string };

/** One row, or null. */
export async function readSiteRow(db: D1Database, namespace: string): Promise<OpsSiteConfig | null> {
  const row = await db.prepare(`SELECT ${SITE_COLUMNS} FROM ops_sites WHERE namespace = ?1`).bind(namespace).first<SiteRow>();
  return row ? configFrom(row) : null;
}

/** Add a row. A namespace that already has one is refused, not replaced. */
export async function addSite(db: D1Database, actor: string, site: SiteInput): Promise<SiteResult> {
  const won = await db
    .prepare(
      `INSERT INTO ops_sites (namespace, name, origin, health_path, platform, script, operator)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(namespace) DO NOTHING RETURNING namespace`
    )
    .bind(site.namespace, site.name, site.origin, site.health_path, site.platform, site.script, site.operator ?? null)
    .first<{ namespace: string }>();
  if (!won) return { ok: false, refusal: `${site.namespace} already has a row. Edit it instead.` };
  const after = await readSiteRow(db, site.namespace);
  if (!after) return { ok: false, refusal: `${site.namespace} was added and then removed before it could be read back.` };
  await db.batch([auditStatement(db, actor, "ops-site-added", site.namespace, null, { after })]);
  return { ok: true, site: after };
}

/** Replace a row's fields, only if it is still at `revision`. An origin change clears
 *  the in-process probe, which is right for Capsid's own origin only. */
export async function editSite(db: D1Database, actor: string, site: SiteInput, revision: number): Promise<SiteResult> {
  const before = await readSiteRow(db, site.namespace);
  if (!before) return { ok: false, refusal: `${site.namespace} has no row to edit. Add it instead.` };
  const selfProbe = before.self_probe && before.origin === site.origin ? 1 : 0;
  const won = await db
    .prepare(
      `UPDATE ops_sites SET name = ?3, origin = ?4, health_path = ?5, platform = ?6, script = ?7, self_probe = ?8,
         operator = CASE WHEN ?9 = 1 THEN ?10 ELSE operator END,
         revision = revision + 1, updated_at = datetime('now')
       WHERE namespace = ?1 AND revision = ?2 RETURNING revision`
    )
    .bind(site.namespace, revision, site.name, site.origin, site.health_path, site.platform, site.script, selfProbe, site.operator === undefined ? 0 : 1, site.operator ?? null)
    .first<{ revision: number }>();
  if (!won) {
    return { ok: false, refusal: `${site.namespace} changed since the preview (it is at revision ${before.revision}, the preview read ${revision}). Preview again.` };
  }
  const after = await readSiteRow(db, site.namespace);
  if (!after) return { ok: false, refusal: `${site.namespace} was edited and then removed before it could be read back.` };
  await db.batch([auditStatement(db, actor, "ops-site-edited", site.namespace, null, { before, after })]);
  return { ok: true, site: after };
}

/** Remove a row, only if it is still at `revision`. The prior row goes in the audit
 *  row, which is the only copy afterwards outside the nightly dump. */
export async function removeSite(db: D1Database, actor: string, namespace: string, revision: number): Promise<SiteResult> {
  const before = await readSiteRow(db, namespace);
  if (!before) return { ok: false, refusal: `${namespace} has no row to remove.` };
  const won = await db
    .prepare("DELETE FROM ops_sites WHERE namespace = ?1 AND revision = ?2 RETURNING namespace")
    .bind(namespace, revision)
    .first<{ namespace: string }>();
  if (!won) {
    return { ok: false, refusal: `${namespace} changed since the preview (it is at revision ${before.revision}, the preview read ${revision}). Preview again.` };
  }
  await db.batch([auditStatement(db, actor, "ops-site-removed", namespace, null, { before })]);
  return { ok: true, site: before };
}
