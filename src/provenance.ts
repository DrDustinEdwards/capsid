import { actorKind } from "./job-touches";

// PROVENANCE TAGS (capsid/decisions.md, 2026-10-03, OWASP hardening item 1, D2). Text that
// Capsid relays from outside it, into a job body or a message a driver reads, is wrapped
// in a labelled fence so a reader can tell data from instruction:
//
//   ~~~external source=<kind> ref=<id>
//   ...the relayed text...
//   ~~~
//
// Tagged at the source, not detected: the places Capsid itself relays outside text are
// few and enumerable (the watcher's evidence, a reviewer's words, and the claims export's
// provenance field). `post` then refuses a body whose external fence is unbalanced or
// lacks a source. It does NOT refuse text a human typed that looks like an instruction:
// there is no reliable pattern, and a refusal nobody can predict teaches people to route
// around the queue.

const FENCE = "~~~";
const OPEN = `${FENCE}external`;
const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_REF = 120;

/** `text` inside an external fence. A line of the text that would close or open a fence
 *  is escaped with a backslash, so relayed text cannot end its own fence and speak outside
 *  it. `maxText` cuts a long relay, marked, so a block reason stays inside its cap. */
export function externalFence(source: string, ref: string, text: string, maxText = 4000): string {
  if (!SOURCE.test(source)) throw new Error(`external fence source '${source}' must be lowercase letters, digits and hyphens`);
  const cleanRef = ref.replace(/\s+/g, " ").trim().slice(0, MAX_REF) || "none";
  const cut = text.length > maxText ? `${text.slice(0, maxText)} [truncated]` : text;
  const body = cut.replace(/^([ \t]{0,3})(~{3,})/gm, (_match, indent: string, tildes: string) => `${indent}\\${tildes}`);
  return `${OPEN} source=${source} ref=${cleanRef}\n${body}\n${FENCE}`;
}

/** Why a body's external fences are malformed, or null when they are well formed or
 *  there are none. A fence needs a `source=<kind>`, may not open inside another, and must
 *  close. A bare `~~~` outside an external fence is an ordinary code fence and is left
 *  alone. */
export function externalFenceProblem(text: string): string | null {
  let openedAt = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(OPEN)) {
      if (openedAt) return `line ${i + 1} opens an external fence inside the one opened at line ${openedAt}`;
      const source = /(?:^|\s)source=(\S+)/.exec(line)?.[1];
      if (!source || !SOURCE.test(source)) return `the external fence at line ${i + 1} has no valid source=<kind> (lowercase letters, digits and hyphens)`;
      openedAt = i + 1;
    } else if (openedAt && /^~{3,}\s*$/.test(line)) {
      openedAt = 0;
    }
  }
  return openedAt ? `the external fence opened at line ${openedAt} is never closed` : null;
}

/** Who a posted job came from: the actor's kind from the one mapping every touch uses,
 *  with the watcher named, since it is the one automatic poster. Recorded in the post's
 *  audit row, not asserted by the caller. */
export function jobOrigin(actor: string): string {
  return actor === "agent:watcher" ? "watcher" : actorKind(actor);
}
