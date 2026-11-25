// 1. An unfilled placeholder is refused (two sessions once stalled on a pasted template that still
// read <ID>). 3. A body stating a pull request merged, a version tagged or a package version
// published is checked against GitHub and npm and refused when Capsid reads otherwise;

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * `text` with fenced blocks and inline code spans blanked, so what is left is prose a session
 * would read as instruction. Line structure is kept.
 */
export function proseOnly(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      out.push("");
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      out.push("");
      continue;
    }
    out.push(line.replace(/(`+)[^`\n]*?\1/g, ""));
  }
  return out.join("\n");
}

const PLACEHOLDERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "<ID>", pattern: /<id>/i },
  { name: "<...>", pattern: /<\.\.\.>/ },
  { name: "{{...}}", pattern: /\{\{[^{}\n]*\}\}/ },
  { name: "TODO:", pattern: /\bTODO:/ },
  { name: "TBD", pattern: /\bTBD\b/ },
];

export function placeholderRefusal(field: string, text: string): string | null {
  const lines = proseOnly(text).split("\n");
  for (const { name, pattern } of PLACEHOLDERS) {
    const at = lines.findIndex((line) => pattern.test(line));
    if (at >= 0) {
      const found = pattern.exec(lines[at])?.[0] ?? name;
      return `the ${field} has an unfilled placeholder, ${found} (line ${at + 1}). A session would stall on it. Fill it in, or put it in a code block or an external fence if it is meant literally. Nothing was written.`;
    }
  }
  return null;
}

export function jobTextRefusal(title: string | undefined, body: string | undefined): string | null {
  return (
    (title === undefined ? null : placeholderRefusal("title", title)) ??
    (body === undefined ? null : placeholderRefusal("body", body))
  );
}

export const heading = (words: string) =>
  new RegExp(
    `^[ \\t]*(?:#{1,6}[ \\t]+)?\\*{0,2}(?:${words})(?=\\*{0,2}(?:[:.,(]|[ \\t]*$)|[ \\t]+\\()`,
    "m",
  );
const PARTS: Array<{ name: string; heading: RegExp }> = [
  { name: "GOAL", heading: heading("GOAL") },
  { name: "DO", heading: heading("DO") },
  { name: "OUT OF SCOPE", heading: heading("OUT OF SCOPE") },
  { name: "DONE WHEN", heading: heading("DONE WHEN") },
  { name: "DECIDED or RULES", heading: heading("DECIDED|RULES") },
];

export function missingPartsWarning(body: string): string | null {
  const prose = proseOnly(body);
  const missing = PARTS.filter((part) => !part.heading.test(prose)).map((part) => part.name);
  if (missing.length === 0) return null;
  return `the body has no heading for: ${missing.join(", ")}. Posted anyway. A session acts best on a body with GOAL, DO, OUT OF SCOPE, DONE WHEN and DECIDED or RULES (docs/work-queue.md, "A body a session can act on").`;
}
