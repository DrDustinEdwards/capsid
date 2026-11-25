import type { Agent } from "./agents";

import { callerIsSeat } from "./jobs-transition";

// Dustin's rulings (capsid/rulings/) are dated records of what he decided, not rules, and no
// session is served them as rules. They are guarded the same way, so an unattended key cannot
// rewrite the record, but they are not canon.

interface CanonRule {
  namespace: string;
  pattern: RegExp;
  label: string;
}

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

export function isCanonPath(namespace: string, path: string): boolean {
  return matches(CANON_RULES, namespace, path);
}

export function canonGuarded(agent: Agent, namespace: string, path: string): boolean {
  return !callerIsSeat(agent) && matches(GUARDED, namespace, path);
}

export function servedCanonPaths(): Array<{ namespace: string; source: string; label: string }> {
  return GUARDED.map((r) => ({
    namespace: r.namespace,
    source: r.pattern.source,
    label: r.label,
  }));
}

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
