// The rule documents sessions follow as rules: a namespace's core.md stays under 8KB, any other
// rule document under 20KB, and none names a tool or action the Worker does not serve.

import { TOOL_GRANTS } from "./scope";
import { COMPOSITES } from "./tools/surface";
import type { OpsMaintenanceItem } from "./ops-types/views";
import { errorMessage } from "@dustinedwards/site-runtime/log";

export const CORE_CAP_BYTES = 8 * 1024;
export const RULE_DOC_CAP_BYTES = 20 * 1024;

const CONVENTIONS = /^conventions(-[a-z0-9]+)*\.md$/;
const DECISIONS = /^decisions\.md$/;

/** The byte cap of a rule document, or null when the path is not one. */
export function ruleDocCap(namespace: string, path: string): number | null {
  if (path === "core.md") return CORE_CAP_BYTES;
  if (DECISIONS.test(path)) return RULE_DOC_CAP_BYTES;
  if (namespace !== "capsid") return null;
  if (CONVENTIONS.test(path)) return RULE_DOC_CAP_BYTES;
  return null;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

// The served surface, as tool -> its actions (null: the tool takes none this check knows).
// Composite actions come from src/tools/surface.ts.
const SERVED: ReadonlyMap<string, ReadonlySet<string> | null> = (() => {
  const out = new Map<string, ReadonlySet<string> | null>();
  for (const tool of Object.keys(TOOL_GRANTS)) out.set(tool, null);
  for (const spec of COMPOSITES) out.set(spec.name, new Set(Object.keys(spec.actions)));
  return out;
})();

// A capsid_* name where the text says it is a tool: a call, a dotted action, an action
// after it, the word tool after it, or "call" before it. A capsid_* field, column or
// cookie (capsid_sha, capsid_portal_csrf) is not a tool and is not read. A Capsid Admin
// name is a tool wherever it appears.
const CAPSID_NAME =
  /(?<![\w-])(capsid_[a-z][a-z_]*[a-z])(?![\w-])`?(?:(\()|\.([a-z_]+)\b|\s+\(?actions?\s+[`"]([a-z_]+)[`"]|\s+(?:\(?actions?|tools?)\b)?/g;
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

// Every tool or action reference in `text` that the Worker does not serve. Fenced code is not read:
// a SQL or JS example there is not a tool reference.
export function staleToolNames(text: string): StaleName[] {
  const found: StaleName[] = [];
  let fenced = false;
  text.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = i + 1;
    for (const m of raw.matchAll(CAPSID_NAME)) {
      const [whole, tool, called, dotted, named] = m;
      const said =
        whole.slice(tool.length).replace(/^`/, "").length > 0 ||
        called !== undefined ||
        CALL_BEFORE.test(raw.slice(0, m.index)) ||
        tool.startsWith("capsid_admin_");
      if (!SERVED.has(tool)) {
        if (said) found.push({ line, text: tool });
        continue;
      }
      const action = dotted ?? named;
      const actions = SERVED.get(tool);
      if (action !== undefined && actions && !actions.has(action))
        found.push({ line, text: `${tool} action ${action}` });
    }
  });
  return found;
}

/** The stale names as one clause: the count and the first five. */
export function staleSummary(stale: readonly StaleName[]): string {
  return `${stale.length} tool(s) or action(s) the Worker does not serve: ${stale
    .slice(0, 5)
    .map((s) => `line ${s.line} "${s.text}"`)
    .join("; ")}`;
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

export function ruleDocProblem(
  namespace: string,
  path: string,
  body: string,
): RuleDocProblem | null {
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

// Refuse a write that makes a rule document worse: over its cap and larger than the stored body, or
// naming a stale tool the stored body did not. A write that cuts an over-cap document, or leaves an
// existing stale name alone, passes, so a violating document can be fixed in steps.
export function ruleDocWriteRefusal(
  namespace: string,
  path: string,
  before: string | null,
  after: string,
): string | null {
  const problem = ruleDocProblem(namespace, path, after);
  if (!problem) return null;
  const reasons: string[] = [];
  if (problem.oversize && (before === null || byteLength(after) > byteLength(before))) {
    const next =
      path === "core.md"
        ? "Rewrite it shorter: current facts only."
        : DECISIONS.test(path)
          ? "Fold rulings into the rules they changed, or move settled ones to archive/."
          : "Cut it, or split it by subject.";
    reasons.push(
      `it would be ${problem.bytes} bytes, over the ${problem.cap}-byte cap for this rule document${before === null ? "" : ` and larger than the ${byteLength(before)} bytes stored`}. ${next}`,
    );
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
        `Use the served names (capsid_find_docs, capsid_write_doc action write, and so on; tools/list has them all).`,
    );
  }
  if (reasons.length === 0) return null;
  return `${namespace}/${path} is a rule document (src/rule-docs.ts). Nothing was written: ${reasons.join(" Also, ")}`;
}

// The daily maintenance pass's rule (src/maintenance.ts): one item per rule document over its cap
// or naming a stale tool, in every namespace, and how many were read. ruleDocCap alone decides
// which documents those are: every path is listed, and only the rule documents' bodies are read.
export async function gatherRuleDocItems(
  db: D1Database,
): Promise<{ items: OpsMaintenanceItem[]; read: number }> {
  try {
    const paths = await db
      .prepare("SELECT namespace, path FROM documents ORDER BY namespace, path")
      .all<{ namespace: string; path: string }>();
    const rule = (paths.results ?? []).filter((r) => ruleDocCap(r.namespace, r.path) !== null);
    const items: OpsMaintenanceItem[] = [];
    // One statement per document in one batch, not one placeholder per row in a single query.
    const bodies =
      rule.length === 0
        ? []
        : await db.batch(
            rule.map((r) =>
              db
                .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
                .bind(r.namespace, r.path),
            ),
          );
    rule.forEach((r, i) => {
      const body =
        ((bodies[i]?.results ?? [])[0] as { body: string | null } | undefined)?.body ?? "";
      const problem = ruleDocProblem(r.namespace, r.path, body);
      if (problem)
        items.push({
          rule: "rule-doc",
          namespace: r.namespace,
          line: `${describeRuleDocProblem(problem)}. Cut it or fix the names.`,
        });
    });
    return { items, read: rule.length };
  } catch (err) {
    const message = errorMessage(err);
    return {
      items: [
        {
          rule: "rule-docs-not-checked",
          namespace: "capsid",
          line: `The rule documents could not be read: ${message}`,
        },
      ],
      read: 0,
    };
  }
}
