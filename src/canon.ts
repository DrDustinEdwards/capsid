import type { Agent } from "./agents";

import { callerIsSeat } from "./jobs-transition";

// CANON WRITE-PROTECTION (OWASP hardening item 2; design:
// capsid/research/design-owasp-hardening.md, "Item 2").
//
// Canon is what every agent is told to trust: the portfolio rules, each namespace's
// core.md and its decisions log. Only the admin, the seat (callerIsSeat: admin or
// can_merge) and a portfolio-wide key (namespaces "*", the key Dustin's own cloud
// sessions use) may write, restore, delete or move one. A key scoped to some namespaces
// (a site driver, a cron) is refused, so a site's agent cannot rewrite the rules it is
// told to trust. Every write is still snapshotted and audit-logged like any other.
//
// Until 2026-10-31 a refused caller's write became a proposal waiting for approval
// (canon_proposals, migrations/0034). Nobody approved them any more, and Dustin's own
// sessions were held there too, so he had the queue deleted (thread "Measure how much
// Claude uses Capsid"). The table and its rows stay, in backups, until a migration drops it.

export interface CanonRule {
  // "*" is every namespace.
  namespace: string;
  pattern: RegExp;
  label: string;
}

// test/canon.test.ts checks what these match.
const CANON_RULES: readonly CanonRule[] = [
  { namespace: "capsid", pattern: /^conventions(-[a-z0-9]+)*\.md$/, label: "capsid/conventions.md and capsid/conventions-<name>.md" },
  { namespace: "*", pattern: /^core\.md$/, label: "<namespace>/core.md" },
  { namespace: "*", pattern: /^(decisions|archive\/decisions(-vol-[1-9][0-9]{0,3})?)\.md$/, label: "<namespace>/decisions.md and its archived volumes" },
];

/** Whether a document is canon. Exact strings: documents are keyed by the exact path,
 *  so "Core.md" or "./core.md" is another document, which no reader takes for canon. */
export function isCanonPath(namespace: string, path: string): boolean {
  return CANON_RULES.some((r) => (r.namespace === "*" || r.namespace === namespace) && r.pattern.test(path));
}

/** Whether this caller is refused a change to this document. */
export function canonGuarded(agent: Agent, namespace: string, path: string): boolean {
  return !callerIsSeat(agent) && agent.scopes.namespaces !== "*" && isCanonPath(namespace, path);
}

/** The list as capsid_run_improve action status serves it, beside protected_paths. */
export function servedCanonPaths(): Array<{ namespace: string; source: string; label: string }> {
  return CANON_RULES.map((r) => ({ namespace: r.namespace, source: r.pattern.source, label: r.label }));
}

/** The refusal a guarded caller gets on a canon path. */
export function canonRefusal(tool: "write" | "restore" | "delete" | "move", namespace: string, path: string): string {
  return (
    `${namespace}/${path} is canon (src/canon.ts), and a ${tool} of it by a key scoped to some namespaces is refused. Nothing changed. ` +
    "Only the admin, the seat or a portfolio-wide key changes canon: ask Dustin's own session to make the change."
  );
}
