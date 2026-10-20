// The rule documents: the ones sessions follow as rules rather than read as records
// (job_c13dc0d4f22f). Two checks hold them:
//
//   - the cap. A namespace's core.md stays under 8KB, any other rule document under 20KB.
//   - stale tool names. A rule document names no tool or action the Worker does not
//     serve. A session that follows a rule naming a removed tool fails at the call.
//
// Dated records (archive/, research/, reports/, audits/, jobs/) are not rule documents:
// they say what was true when written, and an old tool name there is history.
//
// Three places run the checks. capsid_write_doc refuses a write that makes a rule document
// worse (ruleDocWriteRefusal: over the cap and larger than before, or a stale name the
// stored body did not have), so an over-cap document can still be cut in steps.
// capsid_lint_namespace mode report lists every violation in the namespace, and the daily
// maintenance pass files one finding per violating document. test/rule-docs.test.ts
// plants both kinds.

import { rewriteProse, OLD_TOOLS } from "../scripts/tool-names-lib.mjs";
import { TOOL_GRANTS } from "./scope";
import { COMPOSITES } from "./tools/surface";
import { JOB_ACTIONS } from "./jobs-schema";
import type { OpsMaintenanceItem } from "./ops-types";

export const CORE_CAP_BYTES = 8 * 1024;
export const RULE_DOC_CAP_BYTES = 20 * 1024;

const CONVENTIONS = /^conventions(-[a-z0-9]+)*\.md$/;
const DECISIONS = /^decisions\.md$/;
// One document directly inside rulings/, no deeper (src/portfolio-docs.ts reads it the same way).
const RULING = /^rulings\/[a-z0-9][a-z0-9._-]*\.md$/;

/** The byte cap of a rule document, or null when the path is not one. */
export function ruleDocCap(namespace: string, path: string): number | null {
  if (path === "core.md") return CORE_CAP_BYTES;
  if (DECISIONS.test(path)) return RULE_DOC_CAP_BYTES;
  if (namespace !== "capsid") return null;
  if (CONVENTIONS.test(path) || RULING.test(path)) return RULE_DOC_CAP_BYTES;
  return null;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

// The served surface, as tool -> its actions (null: the tool takes none this check knows).
// Composite actions come from src/tools/surface.ts; capsid_work_jobs's from its schema.
const SERVED: ReadonlyMap<string, ReadonlySet<string> | null> = (() => {
  const out = new Map<string, ReadonlySet<string> | null>();
  for (const tool of Object.keys(TOOL_GRANTS)) out.set(tool, null);
  for (const spec of COMPOSITES) out.set(spec.name, new Set(Object.keys(spec.actions)));
  out.set("capsid_work_jobs", new Set(JOB_ACTIONS));
  return out;
})();

// Every action some served tool takes. An old tool name that is still an action somewhere
// (create_branch, delete_branch) is not stale when it stands alone.
const SERVED_ACTIONS: ReadonlySet<string> = new Set([...SERVED.values()].flatMap((a) => (a ? [...a] : [])));

// Old names with an underscore are not words, so outside backticks they still name the old
// tool. rewriteProse reads only backtick spans and calls; this reads the rest. open_pr is
// excluded for the reason rewriteProse gives (it is also a gate class). A name followed by
// "(" is a call, which rewriteProse already reads.
const BARE_OLD = OLD_TOOLS.filter((name) => name.includes("_") && name !== "open_pr" && !SERVED_ACTIONS.has(name));
const BARE_OLD_RE = new RegExp(`(?<![\\w./-])(${BARE_OLD.join("|")})(?![\\w(-])`, "g");

// An old tool name as a whole word, to say which names a line rewriteProse rewrote held.
// Inside capsid_work_jobs, "jobs" follows an underscore and is not a match.
const OLD_WORD = new RegExp(`(?<![\\w-])(${OLD_TOOLS.slice().sort((a, b) => b.length - a.length).join("|")})(?![\\w-])`, "g");

// A capsid_* name where the text says it is a tool: a call, a dotted action, an action
// after it, the word tool after it, or "call" before it. A capsid_* field, column or
// cookie (capsid_sha, capsid_portal_csrf) is not a tool and is not read. A Capsid Admin
// name is a tool wherever it appears.
const CAPSID_NAME = /(?<![\w-])(capsid_[a-z][a-z_]*[a-z])(?![\w-])`?(?:(\()|\.([a-z_]+)\b|\s+\(?actions?\s+[`"]([a-z_]+)[`"]|\s+(?:\(?actions?|tools?)\b)?/g;
const CALL_BEFORE = /\b(call|calls|calling|called|tool|tools|use|ask)\s+`?$/i;

/** One stale reference: the line it is on and the name it uses. */
export interface StaleName {
  line: number;
  text: string;
}

function multiset(names: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of names) out.set(n, (out.get(n) ?? 0) + 1);
  return out;
}

/** Every tool or action reference in `text` that the Worker does not serve. Fenced code is
 *  not read: a SQL or JS example there is not a tool reference. */
export function staleToolNames(text: string): StaleName[] {
  const found: StaleName[] = [];
  // "write(s)" and "item(es)" are plurals, not calls.
  const prose = rewriteProse(text.replace(/\((?:s|es)\)/g, ""));
  // Old names in backtick spans and calls, the migration's own reading of prose. Each
  // rewritten line reports the old names it lost, so an edit elsewhere on the line is not
  // a new stale name.
  for (const c of prose.changes) {
    const lost = multiset([...c.before.matchAll(OLD_WORD)].map((m) => m[1]));
    for (const m of c.after.matchAll(OLD_WORD)) lost.set(m[1], (lost.get(m[1]) ?? 0) - 1);
    for (const [name, n] of lost) for (let k = 0; k < n; k++) found.push({ line: c.line, text: name });
  }
  for (const u of prose.unmapped) found.push({ line: u.line, text: [...u.text.matchAll(OLD_WORD)][0]?.[1] ?? u.text.trim() });
  let fenced = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = i + 1;
    const outside = raw.replace(/`[^`]*`/g, "``");
    for (const m of outside.matchAll(BARE_OLD_RE)) found.push({ line, text: m[1] });
    // capsid_* names: the tool must be served, and an action given must be one of its own.
    for (const m of raw.matchAll(CAPSID_NAME)) {
      const [whole, tool, called, dotted, named] = m;
      const said = whole.slice(tool.length).replace(/^`/, "").length > 0 || called !== undefined || CALL_BEFORE.test(raw.slice(0, m.index)) || tool.startsWith("capsid_admin_");
      if (!SERVED.has(tool)) {
        if (said) found.push({ line, text: tool });
        continue;
      }
      const action = dotted ?? named;
      const actions = SERVED.get(tool);
      if (action !== undefined && actions && !actions.has(action)) found.push({ line, text: `${tool} action ${action}` });
    }
  });
  return found.sort((a, b) => a.line - b.line);
}

/** The stale names as one clause: the count and the first five. */
export function staleSummary(stale: readonly StaleName[]): string {
  return `${stale.length} tool(s) or action(s) the Worker does not serve: ${stale.slice(0, 5).map((s) => `line ${s.line} "${s.text}"`).join("; ")}`;
}

/** What is wrong with one rule document, or null when it is not one or nothing is. */
export interface RuleDocProblem {
  namespace: string;
  path: string;
  bytes: number;
  cap: number;
  oversize: boolean;
  stale: StaleName[];
}

export function ruleDocProblem(namespace: string, path: string, body: string): RuleDocProblem | null {
  const cap = ruleDocCap(namespace, path);
  if (cap === null) return null;
  const bytes = byteLength(body);
  const stale = staleToolNames(body);
  if (bytes <= cap && stale.length === 0) return null;
  return { namespace, path, bytes, cap, oversize: bytes > cap, stale };
}

/** One line per problem, for a refusal, a report or a finding. */
function describeRuleDocProblem(p: RuleDocProblem): string {
  const parts: string[] = [];
  if (p.oversize) parts.push(`${p.bytes} bytes, over its ${p.cap}-byte cap`);
  if (p.stale.length > 0) parts.push(`names ${staleSummary(p.stale)}`);
  return `${p.namespace}/${p.path}: ${parts.join("; ")}`;
}

/** Refuse a write that makes a rule document worse: over its cap and larger than the
 *  stored body, or naming a stale tool the stored body did not. A write that cuts an
 *  over-cap document, or leaves an existing stale name alone, passes, so a violating
 *  document can be fixed in steps. Null when the write may go ahead. */
export function ruleDocWriteRefusal(namespace: string, path: string, before: string | null, after: string): string | null {
  const problem = ruleDocProblem(namespace, path, after);
  if (!problem) return null;
  const reasons: string[] = [];
  if (problem.oversize && (before === null || byteLength(after) > byteLength(before))) {
    const next = path === "core.md" ? "Rewrite it shorter: current facts only." : DECISIONS.test(path) ? "Fold rulings into the rules they changed, or move settled ones to archive/." : "Cut it, or split it by subject.";
    reasons.push(`it would be ${problem.bytes} bytes, over the ${problem.cap}-byte cap for this rule document${before === null ? "" : ` and larger than the ${byteLength(before)} bytes stored`}. ${next}`);
  }
  const had = multiset(before === null ? [] : staleToolNames(before).map((s) => s.text));
  const added: StaleName[] = [];
  for (const s of problem.stale) {
    const left = had.get(s.text) ?? 0;
    if (left > 0) had.set(s.text, left - 1);
    else added.push(s);
  }
  if (added.length > 0) {
    reasons.push(
      `it would name ${staleSummary(added)}. ` +
        `Use the served names (capsid_find_docs, capsid_work_jobs action post, and so on; tools/list has them all).`
    );
  }
  if (reasons.length === 0) return null;
  return `${namespace}/${path} is a rule document (src/rule-docs.ts). Nothing was written: ${reasons.join(" Also, ")}`;
}

/** The daily maintenance pass's rule (src/maintenance.ts): one item per rule document
 *  over its cap or naming a stale tool, in every namespace, and how many were read.
 *  ruleDocCap alone decides which documents those are: every path is listed, and only the
 *  rule documents' bodies are read. A failed read is one rule-docs-not-checked item. */
export async function gatherRuleDocItems(db: D1Database): Promise<{ items: OpsMaintenanceItem[]; read: number }> {
  try {
    const paths = await db.prepare("SELECT namespace, path FROM documents ORDER BY namespace, path").all<{ namespace: string; path: string }>();
    const rule = (paths.results ?? []).filter((r) => ruleDocCap(r.namespace, r.path) !== null);
    const items: OpsMaintenanceItem[] = [];
    // One statement per document, in one batch: never one placeholder per row in a single
    // query (conventions 8.2).
    const bodies = rule.length === 0 ? [] : await db.batch(rule.map((r) => db.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2").bind(r.namespace, r.path)));
    rule.forEach((r, i) => {
      const body = ((bodies[i]?.results ?? [])[0] as { body: string | null } | undefined)?.body ?? "";
      const problem = ruleDocProblem(r.namespace, r.path, body);
      if (problem) items.push({ rule: "rule-doc", namespace: r.namespace, job: null, line: `${describeRuleDocProblem(problem)}. Cut it or fix the names.` });
    });
    return { items, read: rule.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { items: [{ rule: "rule-docs-not-checked", namespace: "capsid", job: null, line: `The rule documents could not be read: ${message}` }], read: 0 };
  }
}
