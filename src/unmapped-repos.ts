import type { Env } from "./env";
import { listInstalledRepos, type InstalledRepo } from "./github/client";

// Repos the GitHub App can see that no namespace maps. A repo is reachable through
// Capsid's tools only if a namespace maps it, and the mapping is the authorization
// boundary (capsid/decisions.md 2026-09-13), so this module only finds the gap. It never
// maps: the seat or Dustin does, through update_namespace.

// Repos that are unmapped on purpose (archived, frozen, or deleted soon), one owner/name
// per line, `#` comments allowed. An unsigned document is enough: it can only silence a
// finding, never map or reach a repo.
const UNMAPPED_ON_PURPOSE_NS = "capsid";
const UNMAPPED_ON_PURPOSE_PATH = "unmapped-repos.md";

export interface RepoMapRead {
  installed: InstalledRepo[];
  installations: number;
  // Lowercased owner/name of every repo any namespace maps.
  mapped: Set<string>;
  onPurpose: Set<string>;
  namespaces: string[];
}

export interface UnmappedRepo extends InstalledRepo {
  suggested: string | null;
}

/** The lines of the on-purpose document as lowercased owner/name. */
export function parseOnPurpose(body: string | null): Set<string> {
  const out = new Set<string>();
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.replace(/#.*/, "").trim().toLowerCase();
    if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(line) && line.split("/").every((part) => part !== "." && part !== "..")) out.add(line);
  }
  return out;
}

/** The namespace a repo most likely belongs in, from its name alone: the repo named
 *  for a namespace, else the longest namespace the name starts with up to a dash. */
export function suggestNamespace(fullName: string, namespaces: string[]): string | null {
  const name = (fullName.split("/")[1] ?? "").toLowerCase();
  if (namespaces.includes(name)) return name;
  const prefixed = namespaces.filter((ns) => name.startsWith(`${ns}-`)).sort((a, b) => b.length - a.length);
  return prefixed[0] ?? null;
}

/** Installed repos that no namespace maps and the on-purpose list does not name. */
export function unmappedRepos(read: RepoMapRead): UnmappedRepo[] {
  return read.installed
    .filter((r) => !read.mapped.has(r.full_name.toLowerCase()) && !read.onPurpose.has(r.full_name.toLowerCase()))
    .map((r) => ({ ...r, suggested: suggestNamespace(r.full_name, read.namespaces) }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/** The App's repos against the namespace mapping. Throws, rather than returning a
 *  partial answer, on anything it cannot read whole: an empty list from the App is not
 *  believed either, because "0 unmapped" over "0 listed" says nothing. */
export async function readRepoMap(env: Env): Promise<RepoMapRead> {
  const { repos, installations } = await listInstalledRepos(env);
  if (repos.length === 0) {
    throw new Error(`the App's ${installations} installation(s) list no repositories at all, which is not believable`);
  }
  const { results } = await env.DB.prepare("SELECT namespace, repos FROM namespaces ORDER BY namespace").all<{ namespace: string; repos: string | null }>();
  const mapped = new Set<string>();
  const namespaces: string[] = [];
  for (const row of results ?? []) {
    namespaces.push(row.namespace);
    let list: unknown;
    try {
      list = JSON.parse(row.repos || "[]");
    } catch {
      throw new Error(`namespace ${row.namespace} has a corrupt repos mapping, so what is unmapped cannot be judged`);
    }
    if (!Array.isArray(list)) throw new Error(`namespace ${row.namespace} has a corrupt repos mapping (not an array)`);
    for (const entry of list as Array<{ repo?: unknown }>) {
      if (typeof entry?.repo === "string") mapped.add(entry.repo.toLowerCase());
    }
  }
  const doc = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(UNMAPPED_ON_PURPOSE_NS, UNMAPPED_ON_PURPOSE_PATH)
    .first<{ body: string | null }>();
  return { installed: repos, installations, mapped, onPurpose: parseOnPurpose(doc?.body ?? null), namespaces };
}
