import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { parseReposList, repoTokenOk, requireSinglePrimary, type RepoEntry } from "./github/client";
import { MAX_NAMESPACE, MAX_REPO_SELECTOR, MAX_REPOS_JSON } from "./limits";
import { auditStatement, isMissingRowAbort } from "./store-guards";

// Shared by capsid_admin_manage_namespaces and the namespace_add and namespace_edit controls.

const NAMESPACE = /^[a-z0-9][a-z0-9-]*$/;

export function namespaceNameRefusal(namespace: string | undefined): string | null {
  if (!namespace) return "namespace is required";
  if (namespace.length > MAX_NAMESPACE || !NAMESPACE.test(namespace))
    return `'${namespace}' is not a namespace: a lowercase slug of a-z, 0-9 and '-', at most ${MAX_NAMESPACE} characters.`;
  return null;
}

/** One repo with an optional label (default primary), or a repos JSON array with one primary. */
export function registerRepos(input: {
  repo?: string;
  label?: string;
  repos?: string;
}): { ok: true; list: RepoEntry[] } | { ok: false; refusal: string } {
  let list: RepoEntry[];
  if (input.repos) {
    if (input.repos.length > MAX_REPOS_JSON)
      return { ok: false, refusal: `repos is at most ${MAX_REPOS_JSON} characters.` };
    const parsed = parseReposList(input.repos);
    if ("error" in parsed) return { ok: false, refusal: parsed.error };
    list = parsed.list;
  } else {
    if (!input.repo || input.repo.length > MAX_REPO_SELECTOR || !repoTokenOk(input.repo))
      return { ok: false, refusal: 'provide repo as "owner/name", or pass a repos JSON array' };
    const label = (input.label ?? "primary").trim() || "primary";
    if (label.length > MAX_REPO_SELECTOR)
      return { ok: false, refusal: `label is at most ${MAX_REPO_SELECTOR} characters.` };
    list = [{ repo: input.repo, label }];
  }
  // Two primaries or none would make every repo tool resolve by accident, and update would refuse to
  // fix it in place.
  const primaryError = requireSinglePrimary(list);
  return primaryError ? { ok: false, refusal: primaryError } : { ok: true, list };
}

/** An update's repo mapping: a repos JSON array with exactly one entry labeled primary. */
export function updateRepos(
  repos: string | undefined,
): { ok: true; list: RepoEntry[] } | { ok: false; refusal: string } {
  if (!repos)
    return {
      ok: false,
      refusal: 'repos is required: a JSON array like [{"repo":"owner/name","label":"primary"}]',
    };
  if (repos.length > MAX_REPOS_JSON)
    return { ok: false, refusal: `repos is at most ${MAX_REPOS_JSON} characters.` };
  const parsed = parseReposList(repos);
  if ("error" in parsed) return { ok: false, refusal: parsed.error };
  const primaryError = requireSinglePrimary(parsed.list);
  return primaryError ? { ok: false, refusal: primaryError } : { ok: true, list: parsed.list };
}

export async function namespaceRepos(db: D1Database, namespace: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
    .bind(namespace)
    .first<{ repos: string }>();
  return row ? row.repos : null;
}

// A preview binds the digest, not the mapping, which could outgrow the confirmation token.
export function reposDigest(repos: string): Promise<string> {
  return sha256Hex(repos);
}

export const ALREADY_REGISTERED = (namespace: string) =>
  `namespace already registered: ${namespace}. Use capsid_admin_manage_namespaces action update to change its repo mapping; it snapshots the prior mapping to the audit log.`;
export const NOT_REGISTERED = (namespace: string) =>
  `namespace not found: ${namespace}. Use capsid_admin_manage_namespaces action register to create it.`;

/** Create-only: refused if the namespace exists. The row and its audit row in one batch. */
export async function registerNamespace(
  db: D1Database,
  actor: string,
  namespace: string,
  list: RepoEntry[],
): Promise<{ ok: true } | { ok: false; refusal: string }> {
  if ((await namespaceRepos(db, namespace)) !== null)
    return { ok: false, refusal: ALREADY_REGISTERED(namespace) };
  await db.batch([
    db
      .prepare("INSERT INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(namespace, JSON.stringify(list)),
    auditStatement(db, actor, "register_namespace", namespace, null, list),
  ]);
  return { ok: true };
}

/**
 * Remaps a namespace's repos, the prior mapping in the audit row. With `expectedDigest`, the
 * mapping must still be the one a preview read.
 */
export async function updateNamespace(
  db: D1Database,
  actor: string,
  namespace: string,
  list: RepoEntry[],
  expectedDigest?: string,
): Promise<{ ok: true; previous: string } | { ok: false; refusal: string }> {
  const previous = await namespaceRepos(db, namespace);
  if (previous === null) return { ok: false, refusal: NOT_REGISTERED(namespace) };
  if (expectedDigest !== undefined && (await reposDigest(previous)) !== expectedDigest) {
    return {
      ok: false,
      refusal: `${namespace}'s repo mapping changed since the preview. Preview again.`,
    };
  }
  const reposJson = JSON.stringify(list);
  // The guard aborts the batch when the mapping is no longer the one read, so a second admin's edit
  // in between is never overwritten.
  const guard = db
    .prepare(
      `INSERT INTO document_versions (document_id, namespace, path)
       SELECT NULL, ?1, '' WHERE NOT EXISTS (SELECT 1 FROM namespaces WHERE namespace = ?1 AND repos IS ?2)`,
    )
    .bind(namespace, previous);
  try {
    await db.batch([
      guard,
      db
        .prepare("UPDATE namespaces SET repos = ?2 WHERE namespace = ?1")
        .bind(namespace, reposJson),
      auditStatement(db, actor, "update_namespace", namespace, null, {
        old: previous,
        new: reposJson,
      }),
    ]);
  } catch (err) {
    if (!isMissingRowAbort(err)) throw err;
    return {
      ok: false,
      refusal: `${namespace}'s repo mapping changed while it was written. Try again.`,
    };
  }
  return { ok: true, previous };
}
