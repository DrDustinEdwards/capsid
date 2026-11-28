// PROVENANCE TAGS (OWASP hardening item 1).

const FENCE = "~~~";
const OPEN = `${FENCE}external`;
const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_REF = 120;

// `text` inside an external fence. A line of the text that would close or open a fence is escaped
// with a backslash, so relayed text cannot end its own fence and speak outside it. `maxText` cuts a
// long relay, marked, so a block reason stays inside its cap.
export function externalFence(source: string, ref: string, text: string, maxText = 4000): string {
  if (!SOURCE.test(source))
    throw new Error(
      `external fence source '${source}' must be lowercase letters, digits and hyphens`,
    );
  const cleanRef = ref.replace(/\s+/g, " ").trim().slice(0, MAX_REF) || "none";
  const cut = text.length > maxText ? `${text.slice(0, maxText)} [truncated]` : text;
  const body = cut.replace(
    /^([ \t]{0,3})(~{3,})/gm,
    (_match, indent: string, tildes: string) => `${indent}\\${tildes}`,
  );
  return `${OPEN} source=${source} ref=${cleanRef}\n${body}\n${FENCE}`;
}

export function unfence(text: string): string {
  const m = text.match(/^~~~external source=[a-z][a-z0-9-]{0,31} ref=[^\n]*\n([\s\S]*)\n~~~$/);
  return m ? m[1]!.replace(/^([ \t]{0,3})\\(~{3,})/gm, "$1$2") : text;
}
