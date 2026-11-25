import type { Agent } from "./agents";

import { callerIsSeat } from "./jobs-transition";

// CANON WRITE-PROTECTION (OWASP hardening item 2; design:
// capsid/research/design-owasp-hardening.md, "Item 2").
//
// Canon is what every agent is told to trust: the portfolio rules, each namespace's
// core.md and its decisions log. Only the admin and the seat (callerIsSeat: admin or
// can_merge) may write, restore, delete or move one. Every other key is refused, the
// portfolio-wide one (namespaces "*", the key unattended routine sessions use) included:
// those sessions read outside text, and a poisoned one must not rewrite the rules every
// later session is served (Capsid security review, round 4, finding 3). Every write is
// still snapshotted and audit-logged like any other.
//
// Dustin's rulings (capsid/rulings/) are dated records of what he decided, not rules, and
// no session is served them as rules. They are guarded the same way,
// so an unattended key cannot rewrite the record, but they are not canon.
//
// A refused write is refused outright; nothing queues it for approval.

interface CanonRule {
  // "*" is every namespace.
  namespace: string;
  pattern: RegExp;
  label: string;
}

// test/canon.test.ts checks what these match.
const CANON_RULES: readonly CanonRule[] = [
  {
    namespace: "capsid",
    pattern: /^conventions(-[a-z0-9]+)*\.md$/,
    label: "capsid/conventions.md and capsid/conventions-<name>.md",
  },
  { namespace: "*", pattern: /^core\.md$/, label: "<namespace>/core.md" },
  {
    namespace: "*",
    pattern: /^(decisions|archive\/decisions)\.md$/,
    label: "<namespace>/decisions.md",
  },
];

// Guarded like canon, but records: nothing serves these as rules.
const GUARDED: readonly CanonRule[] = [
  ...CANON_RULES,
  {
    namespace: "capsid",
    pattern: /^rulings\/[a-z0-9][a-z0-9._-]*\.md$/,
    label: "capsid/rulings/<name>.md (records of Dustin's rulings, not rules)",
  },
];

const matches = (rules: readonly CanonRule[], namespace: string, path: string): boolean =>
  rules.some((r) => (r.namespace === "*" || r.namespace === namespace) && r.pattern.test(path));

/** Whether a document is canon. Exact strings: documents are keyed by the exact path,
 *  so "Core.md" or "./core.md" is another document, which no reader takes for canon. */
export function isCanonPath(namespace: string, path: string): boolean {
  return matches(CANON_RULES, namespace, path);
}

/** Whether this caller is refused a change to this document. */
export function canonGuarded(agent: Agent, namespace: string, path: string): boolean {
  return !callerIsSeat(agent) && matches(GUARDED, namespace, path);
}

/** The guarded list as capsid_read_status action status serves it, beside protected_paths. */
export function servedCanonPaths(): Array<{ namespace: string; source: string; label: string }> {
  return GUARDED.map((r) => ({
    namespace: r.namespace,
    source: r.pattern.source,
    label: r.label,
  }));
}

/** The refusal a guarded caller gets on a canon path. */
export function canonRefusal(
  tool: "write" | "restore" | "delete" | "move",
  namespace: string,
  path: string,
): string {
  return (
    `${namespace}/${path} is canon or a ruling (src/canon.ts), and a ${tool} of it by an agent key is refused. Nothing changed. ` +
    "Only the admin or the seat changes it: ask Dustin's own session to make the change."
  );
}
