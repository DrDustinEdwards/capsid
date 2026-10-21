import type { Env } from "./env";
import { isCanonPath } from "./canon";
import { ghFetch, resolveRepo } from "./github/client";
import { readPrFiles, type PrFileRow } from "./github/pr-files";
import { logEvent } from "./log";
import { externalFence } from "./provenance";
import type { Finding } from "./watcher-detect";
import { DAY_MS } from "./time";

// STALE CANON AFTER A MERGE (Capsid improvement list, item 23: Foxhound's ROUTES.md and
// DESIGN.md still said the admin reused the app shell after a pull request changed it).
// Each watcher pass:
//
//   1. lists each mapped namespace's newest closed pull requests (its primary repo, one
//      read each) and reads the changed files of up to MAX_PR_READS_PER_PASS that merged
//      into the default branch and are not yet remembered. What each one removed, renamed
//      and modified is kept in APP_KV under STALE_CANON_KEY for RETAIN_DAYS.
//   2. matches the remembered merges against each namespace's canon documents
//      (staleCanonDoc below) and its typed edges, and raises one digest finding per
//      document and pull request:
//        - a document that cites, in its body or by an edge to `<namespace>/<path>`, a
//          file the pull request deleted or renamed (and no later merge brought back);
//        - a document with an edge to a file the pull request modified.
//   A document written after the merge is not flagged: its writer had the chance to read
//   the change. So the finding clears when the document is next written, when the
//   citation or edge goes away, or when the merge leaves the window.
//
// Nothing here writes a document. The finding is the whole act.
//
// Out of scope for this version: a document that describes the old behaviour in words
// without naming a path (Foxhound's own case), edges from another namespace's documents,
// and a namespace's repos other than its primary. Those need a reader of meaning, not of
// paths.

const STALE_CANON_KEY = "stale-canon:merges";
const RETAIN_DAYS = 30;
const RETAIN_MS = RETAIN_DAYS * DAY_MS;
// Reads per pass: one pull request list per namespace (at most MAX_NAMESPACES), the
// files of at most MAX_PR_READS_PER_PASS pull requests, and two D1 reads per namespace
// with a remembered merge. A burst of merges is caught up over the next passes.
export const MAX_NAMESPACES = 20;
const MAX_PR_READS_PER_PASS = 5;
const PULLS_LISTED = 20;
// Paths kept per list per pull request. A larger change is kept cut, and says so.
export const MAX_PATHS_PER_PR = 300;
const MAX_DOCS_PER_NAMESPACE = 200;
const MAX_EDGES_PER_NAMESPACE = 2000;
// Findings per pass. Sorted first, so the same ones are shown pass after pass.
export const MAX_FLAGS = 40;
const CITED_SHOWN = 6;

// What a merge did to the repo's files, as remembered.
export interface MergedChange {
  number: number;
  url: string;
  merged_at: string;
  // Deleted (to: null) or renamed away (to: the new path).
  removed: Array<{ path: string; to: string | null }>;
  // Modified in place.
  changed: string[];
  // Added, or the new name of a rename: a later merge that brings a path back.
  added: string[];
  // Why the lists are not the whole pull request, or null.
  partial: string | null;
}

interface NamespaceMerges {
  repo: string;
  prs: MergedChange[];
}

export type MergeMemory = Record<string, NamespaceMerges>;

/** What one pull request's file rows remove, rename, modify and add. Pure. */
export function changeFromFiles(rows: readonly PrFileRow[]): Pick<MergedChange, "removed" | "changed" | "added" | "partial"> {
  const removed: MergedChange["removed"] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const f of rows) {
    if (f.previous_filename && f.previous_filename !== f.filename) {
      removed.push({ path: f.previous_filename, to: f.filename });
      added.push(f.filename);
    } else if (f.status === "removed") removed.push({ path: f.filename, to: null });
    else if (f.status === "added" || f.status === "copied") added.push(f.filename);
    // modified, changed, and a rename to the same name: the file is still there.
    else changed.push(f.filename);
  }
  const cut = removed.length > MAX_PATHS_PER_PR || changed.length > MAX_PATHS_PER_PR || added.length > MAX_PATHS_PER_PR;
  return {
    removed: removed.slice(0, MAX_PATHS_PER_PR),
    changed: changed.slice(0, MAX_PATHS_PER_PR),
    added: added.slice(0, MAX_PATHS_PER_PR),
    partial: cut ? `more than ${MAX_PATHS_PER_PR} paths in one list; the first ${MAX_PATHS_PER_PR} were kept` : null,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `body` names `path` as a whole path: "src/a.ts" in "see src/a.ts." but not in
 *  "src/a.tsx", "src/a.ts.bak" or "lib/src/a.ts". A path with neither a slash nor a dot
 *  ("Makefile") is an ordinary word in prose and is never matched by body; an edge to it
 *  still counts. Pure. */
export function citesPath(body: string, path: string): boolean {
  if (!path.includes("/") && !path.includes(".")) return false;
  return new RegExp(`(?<![\\w./-])${escapeRe(path)}(?![\\w/-]|\\.\\w)`).test(body);
}

// The types that say how an app works, beside the canon paths (src/canon.ts).
const CANON_TYPES: ReadonlySet<string> = new Set(["core", "spec", "protocol", "procedural", "reference"]);
// Dated records say what was true when written (src/rule-docs.ts); an old path there is history.
const DATED_PREFIXES = ["archive/", "research/", "reports/", "audits/", "jobs/"];
const RETIRED_STATUSES: ReadonlySet<string> = new Set(["superseded", "closed"]);

export interface CanonDoc {
  path: string;
  type: string | null;
  status: string | null;
  updated_at: string;
  body: string | null;
}

/** Whether a document is one this check holds to the code: a canon path or a canon type,
 *  not a dated record, not retired. Pure. */
export function staleCanonDoc(namespace: string, doc: Pick<CanonDoc, "path" | "type" | "status">): boolean {
  if (DATED_PREFIXES.some((p) => doc.path.startsWith(p))) return false;
  if (doc.status && RETIRED_STATUSES.has(doc.status)) return false;
  return isCanonPath(namespace, doc.path) || (doc.type !== null && CANON_TYPES.has(doc.type));
}

/** A D1 datetime ("2026-10-18 09:00:00", UTC) or an ISO string, as milliseconds. */
export function instant(at: string): number {
  const iso = /[zZ]$|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

export interface Edge {
  from_path: string;
  type: string;
  to_path: string;
}

interface Cited {
  path: string;
  how: "deleted" | "renamed" | "changed";
  to: string | null;
  via: "body" | "edge";
}

export interface StaleFlag {
  namespace: string;
  doc: string;
  pr: number;
  url: string;
  merged_at: string;
  cited: Cited[];
  partial: string | null;
}

/** The documents each remembered merge leaves stale, per the rules at the top of this
 *  file. One flag per document and pull request, naming every path it cites. Pure. */
export function staleCanonFlags(namespace: string, merges: readonly MergedChange[], docs: readonly CanonDoc[], edges: readonly Edge[]): StaleFlag[] {
  const ordered = [...merges].sort((a, b) => instant(a.merged_at) - instant(b.merged_at));
  const edgesFrom = new Map<string, Set<string>>();
  for (const e of edges) edgesFrom.set(e.from_path, (edgesFrom.get(e.from_path) ?? new Set()).add(e.to_path));
  const flags: StaleFlag[] = [];
  ordered.forEach((pr, i) => {
    const merged = instant(pr.merged_at);
    if (Number.isNaN(merged)) return;
    // A path a later merge added back, or modified, exists again.
    const later = new Set(ordered.slice(i + 1).flatMap((p) => [...p.added, ...p.changed]));
    for (const doc of docs) {
      if (!staleCanonDoc(namespace, doc)) continue;
      const written = instant(doc.updated_at);
      // Written since the merge, or a stamp that does not parse: not judged stale.
      if (Number.isNaN(written) || written >= merged) continue;
      const linked = edgesFrom.get(doc.path) ?? new Set<string>();
      const cited: Cited[] = [];
      for (const r of pr.removed) {
        if (later.has(r.path)) continue;
        const how = r.to === null ? "deleted" : "renamed";
        if (linked.has(r.path)) cited.push({ path: r.path, how, to: r.to, via: "edge" });
        else if (citesPath(doc.body ?? "", r.path)) cited.push({ path: r.path, how, to: r.to, via: "body" });
      }
      for (const path of pr.changed) {
        if (linked.has(path)) cited.push({ path, how: "changed", to: null, via: "edge" });
      }
      if (cited.length > 0) flags.push({ namespace, doc: doc.path, pr: pr.number, url: pr.url, merged_at: pr.merged_at, cited, partial: pr.partial });
    }
  });
  return flags;
}

// FNV-1a, 32 bits: a short stable tag for a document path inside a fingerprint, which
// must hold no "]" (the title carries it in brackets).
function tag(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const STALE_CANON_PREFIX = "stale-canon-";

/** One fingerprint per document and pull request: stable while both stand. */
export function staleCanonFingerprint(flag: Pick<StaleFlag, "namespace" | "doc" | "pr">): string {
  return `${STALE_CANON_PREFIX}${flag.namespace}-${flag.pr}-${tag(flag.doc)}`;
}

const describe = (c: Cited): string =>
  `${c.path} (${c.how === "renamed" ? `renamed to ${c.to}` : c.how}; cited by ${c.via === "edge" ? "a typed edge" : "path in the body"})`;

/** The flags as watcher findings, sorted and capped at MAX_FLAGS. Pure. */
export function staleCanonFindings(flags: readonly StaleFlag[]): Finding[] {
  const sorted = [...flags].sort((a, b) => a.namespace.localeCompare(b.namespace) || b.pr - a.pr || a.doc.localeCompare(b.doc));
  return sorted.slice(0, MAX_FLAGS).map((f) => {
    const fingerprint = staleCanonFingerprint(f);
    const first = f.cited[0]!;
    const more = f.cited.length > 1 ? ` and ${f.cited.length - 1} more` : "";
    const verb = first.how === "renamed" ? "renamed" : first.how;
    const headline = `${f.namespace}/${f.doc} may be stale after PR #${f.pr}: it cites ${first.path}${more}, which the PR ${verb}`;
    const evidence = [
      `document: ${f.namespace}/${f.doc}`,
      `pull request: ${f.url}, merged ${f.merged_at}`,
      ...f.cited.slice(0, CITED_SHOWN).map((c) => `cites ${describe(c)}`),
      ...(f.cited.length > CITED_SHOWN ? [`and ${f.cited.length - CITED_SHOWN} more cited path(s)`] : []),
      ...(f.partial ? [`the pull request's file list was kept cut: ${f.partial}`] : []),
      "Read the document against the pull request and rewrite what no longer holds. Writing it clears this; nothing was rewritten.",
    ];
    return {
      fingerprint,
      namespace: f.namespace,
      title: `Watcher: ${headline} [${fingerprint}]`,
      body: [
        "A canon document cites a file a merged pull request removed, renamed or changed (src/stale-canon.ts).",
        "",
        "## Evidence",
        "",
        externalFence("watcher-evidence", fingerprint, evidence.map((line) => `- ${line}`).join("\n")),
      ].join("\n"),
      evidence,
    };
  });
}

// ---------------------------------------------------------------------------
// The memory, and the merges still to read.

/** The stored memory, or null with the reason when it does not parse. Absent is empty. */
export function parseMemory(raw: string | null): { memory: MergeMemory } | { problem: string } {
  if (raw === null) return { memory: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "not an object" };
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      const ns = v as Partial<NamespaceMerges> | null;
      if (!ns || typeof ns.repo !== "string" || !Array.isArray(ns.prs)) return { problem: "a namespace entry has no repo or prs" };
    }
    return { memory: parsed as MergeMemory };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

/** The memory without the merges older than RETAIN_DAYS. Pure. */
export function pruneMemory(memory: MergeMemory, now: Date): MergeMemory {
  const out: MergeMemory = {};
  for (const [ns, entry] of Object.entries(memory)) {
    const prs = entry.prs.filter((p) => now.getTime() - instant(p.merged_at) <= RETAIN_MS);
    if (prs.length > 0) out[ns] = { repo: entry.repo, prs };
  }
  return out;
}

export interface ListedPull {
  number: number;
  html_url: string;
  merged_at: string | null;
  base?: { ref?: string; repo?: { default_branch?: string } };
}

/** The listed pull requests that merged into the default branch inside the window and
 *  are not remembered yet, oldest first. Pure. */
export function newMerges(listed: readonly ListedPull[], known: ReadonlySet<number>, now: Date): ListedPull[] {
  return listed
    .filter((p) => p.merged_at !== null && !known.has(p.number))
    .filter((p) => p.base?.ref !== undefined && p.base.ref === p.base.repo?.default_branch)
    .filter((p) => now.getTime() - instant(p.merged_at!) <= RETAIN_MS)
    .sort((a, b) => instant(a.merged_at!) - instant(b.merged_at!));
}

/** The namespaces this pass reads, from a list read with one row past the cap, and the
 *  memory with every namespace no longer mapped forgotten. Past the cap the list is not
 *  the whole mapping, so a namespace missing from it may still be mapped: nothing is
 *  forgotten then, and the pass is not complete. Mutates `memory`. */
export function namespacesThisPass(rows: readonly string[], memory: MergeMemory): { listed: string[]; capped: boolean } {
  const capped = rows.length > MAX_NAMESPACES;
  const listed = rows.slice(0, MAX_NAMESPACES);
  if (!capped) {
    const names = new Set(listed);
    for (const ns of Object.keys(memory)) if (!names.has(ns)) delete memory[ns];
  }
  return { listed, capped };
}

// ---------------------------------------------------------------------------
// The pass.

export interface StaleCanonRead {
  findings: Finding[];
  // The memory and every namespace's documents were read, so a finding not raised has
  // cleared. A GitHub read that failed only delays a merge, so it does not count here.
  complete: boolean;
  note: string;
}

export async function readStaleCanon(env: Env, now: Date): Promise<StaleCanonRead> {
  let complete = true;
  const parsed = parseMemory(await env.APP_KV.get(STALE_CANON_KEY));
  if ("problem" in parsed) {
    // Logged and started again, never silently dropped. The findings it held are not
    // cleared on this pass: the check does not count as run.
    logEvent("error", "STALE_CANON_MEMORY_UNREADABLE", { message: `STALE_CANON_MEMORY_UNREADABLE: ${parsed.problem}; starting it again` });
    complete = false;
  }
  const before = "memory" in parsed ? JSON.stringify(parsed.memory) : null;
  const memory = pruneMemory("memory" in parsed ? parsed.memory : {}, now);

  const { results: mapped } = await env.DB.prepare(
    "SELECT namespace FROM namespaces WHERE repos IS NOT NULL AND repos NOT IN ('', '[]') ORDER BY namespace LIMIT ?1"
  )
    .bind(MAX_NAMESPACES + 1)
    .all<{ namespace: string }>();

  // Every namespace's new merges, then the oldest MAX_PR_READS_PER_PASS of them read.
  // A namespace no longer mapped is forgotten, unless the list hit MAX_NAMESPACES.
  const { listed, capped } = namespacesThisPass((mapped ?? []).map((m) => m.namespace), memory);
  if (capped) complete = false;
  const pending: Array<{ namespace: string; owner: string; repo: string; pull: ListedPull }> = [];
  const unread: string[] = [];
  for (const namespace of listed) {
    try {
      const { owner, repo, full } = await resolveRepo(env, namespace);
      // A namespace remapped to another repo starts again: its paths were another repo's.
      if (memory[namespace] && memory[namespace].repo !== full) delete memory[namespace];
      const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PULLS_LISTED}`);
      if (!resp.ok) throw new Error(`the pull request list returned ${resp.status}`);
      const listed = (await resp.json()) as ListedPull[];
      const known = new Set((memory[namespace]?.prs ?? []).map((p) => p.number));
      for (const pull of newMerges(Array.isArray(listed) ? listed : [], known, now)) pending.push({ namespace, owner, repo, pull });
      memory[namespace] ??= { repo: full, prs: [] };
    } catch (err) {
      unread.push(`${namespace} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  pending.sort((a, b) => instant(a.pull.merged_at!) - instant(b.pull.merged_at!));
  let read = 0;
  for (const p of pending.slice(0, MAX_PR_READS_PER_PASS)) {
    try {
      const files = await readPrFiles(env, p.owner, p.repo, p.pull.number);
      const change = changeFromFiles(files.rows);
      memory[p.namespace]!.prs.push({
        number: p.pull.number,
        url: p.pull.html_url,
        merged_at: p.pull.merged_at!,
        ...change,
        partial: [files.problem, change.partial].filter(Boolean).join("; ") || null,
      });
      read++;
    } catch (err) {
      unread.push(`${p.namespace} #${p.pull.number} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const kept = pruneMemory(memory, now);
  if (JSON.stringify(kept) !== before) await env.APP_KV.put(STALE_CANON_KEY, JSON.stringify(kept));

  const flags: StaleFlag[] = [];
  for (const [namespace, entry] of Object.entries(kept)) {
    // The candidates in SQL; staleCanonDoc decides.
    const [docs, edges] = await env.DB.batch([
      env.DB.prepare(
        `SELECT path, type, status, updated_at, body FROM documents
         WHERE namespace = ?1 AND path NOT LIKE 'archive/%'
           AND (type IN (SELECT value FROM json_each(?2)) OR path = 'core.md' OR path = 'decisions.md' OR path LIKE 'conventions%')
         ORDER BY path LIMIT ?3`
      ).bind(namespace, JSON.stringify([...CANON_TYPES]), MAX_DOCS_PER_NAMESPACE),
      env.DB.prepare("SELECT from_path, type, to_path FROM document_links WHERE from_ns = ?1 AND to_ns = ?1 LIMIT ?2").bind(namespace, MAX_EDGES_PER_NAMESPACE),
    ]);
    flags.push(...staleCanonFlags(namespace, entry.prs, (docs?.results ?? []) as CanonDoc[], (edges?.results ?? []) as Edge[]));
  }
  const findings = staleCanonFindings(flags);
  const remembered = Object.values(kept).reduce((n, e) => n + e.prs.length, 0);
  const note =
    `${listed.length} namespace(s) listed${capped ? ` (more than ${MAX_NAMESPACES} are mapped; the rest were not read)` : ""}, ${read} of ${pending.length} new merge(s) read, ${remembered} remembered, ${flags.length} stale document flag(s)` +
    (flags.length > MAX_FLAGS ? `, the first ${MAX_FLAGS} raised` : "") +
    (unread.length ? `; not read: ${unread.join(", ")}` : "");
  return { findings, complete, note };
}
