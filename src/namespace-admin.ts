import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { parseReposList, repoTokenOk, requireSinglePrimary } from "./github";
import type { RepoEntry } from "./github/client";
import { MAX_NAMESPACE, MAX_REPO_SELECTOR, MAX_REPOS_JSON } from "./limits";
import { auditStatement } from "./store-guards";

// Registering and remapping a namespace, the one row in the namespaces table that the repo
// tools and the namespaces list read. Two doors share it: capsid_admin_manage_namespaces
// actions register and update (src/tools/namespaces.ts), and the namespace_add and
// namespace_edit controls (src/controls.ts), so the rules and the audit rows are written once.
// Deleting is src/namespace-delete.ts.

const NAMESPACE = /^[a-z0-9][a-z0-9-]*$/;

/** Why a namespace name is refused, or null: the slug the tools' nsName takes. */
export function namespaceNameRefusal(namespace: string | undefined): string | null {
  if (!namespace) return "namespace is required";
  if (namespace.length > MAX_NAMESPACE || !NAMESPACE.test(namespace))
    return `'${namespace}' is not a namespace: a lowercase slug of a-z, 0-9 and '-', at most ${MAX_NAMESPACE} characters.`;
  return null;
}

/** A register's repo mapping: one repo as 'owner/name' with an optional label (default
 *  'primary'), or a repos JSON array, with exactly one entry labeled primary. */
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
  // Two primaries or none would make every repo tool resolve by accident, and update
  // would refuse to fix it in place.
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

/** The mapping the namespace holds now, as stored, or null when it is not registered. */
export async function namespaceRepos(db: D1Database, namespace: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT repos FROM namespaces WHERE namespace = ?1")
    .bind(namespace)
    .first<{ repos: string }>();
  return row ? row.repos : null;
}

/** A digest of a stored mapping, which a preview binds so the perform refuses an edit made
 *  in between (the mapping itself could outgrow the confirmation token). */
export function reposDigest(repos: string): Promise<string> {
  return sha256Hex(repos);
}

export const ALREADY_REGISTERED = (namespace: string) =>
  `namespace already registered: ${namespace}. Use capsid_admin_manage_namespaces action update to change its repo mapping; it snapshots the prior mapping to the audit log.`;
export const NOT_REGISTERED = (namespace: string) =>
  `namespace not found: ${namespace}. Use capsid_admin_manage_namespaces action register to create it.`;

/** Register: create-only, refused if the namespace exists. One batch, the row and its
 *  audit row 'register_namespace'. */
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

/** Update: remap an existing namespace's repos, recording the prior mapping in the audit row
 *  'update_namespace'. It does not rename the namespace or move its documents. With
 *  `expectedDigest`, the mapping must still be the one a preview read. */
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
  await db.batch([
    db.prepare("UPDATE namespaces SET repos = ?2 WHERE namespace = ?1").bind(namespace, reposJson),
    auditStatement(db, actor, "update_namespace", namespace, null, {
      old: previous,
      new: reposJson,
    }),
  ]);
  return { ok: true, previous };
}
