// A job body a session can act on (job_9a8d13d2d926, Dustin 2026-10-10). Two checks, run
// by the capsid_work_jobs tool on a caller's post and edit, and by nothing else: the
// watcher, the skills refresh and the finalize step post through postJob and are not
// subject to them.
//
// 1. An unfilled placeholder is refused. Tonight two sessions stalled on a pasted
//    template that still read <ID>. Text in a code block or an external fence is exempt,
//    since a body may quote a template or relay text it did not write.
// 2. A body missing any of the five headed parts is accepted with a warning, because a
//    refusal nobody can predict teaches people to route around the queue
//    (src/provenance.ts makes the same call).

// A fenced block: ``` or ~~~ (an external fence is a ~~~ fence), closed by a line of at
// least as many of the same character, or by the end of the text.
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** `text` with fenced blocks and inline code spans blanked, so what is left is prose a
 *  session would read as instruction. Line structure is kept. */
function proseOnly(text: string): string {
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

/** The refusal for the first unfilled placeholder in `text`, naming it and where it is, or
 *  null. `field` is "title" or "body". */
export function placeholderRefusal(field: string, text: string): string | null {
  const lines = proseOnly(text).split("\n");
  for (const { name, pattern } of PLACEHOLDERS) {
    const at = lines.findIndex((line) => pattern.test(line));
    if (at >= 0) {
      // The text as written, so <id> is named as <id> and not as the <ID> pattern.
      const found = pattern.exec(lines[at])?.[0] ?? name;
      return `the ${field} has an unfilled placeholder, ${found} (line ${at + 1}). A session would stall on it. Fill it in, or put it in a code block or an external fence if it is meant literally. Nothing was written.`;
    }
  }
  return null;
}

/** The refusal for an unfilled placeholder in a job's title or body, or null. */
export function jobTextRefusal(title: string | undefined, body: string | undefined): string | null {
  return (title === undefined ? null : placeholderRefusal("title", title)) ?? (body === undefined ? null : placeholderRefusal("body", body));
}

// The five headed parts. DECIDED and RULES are alternatives for the fifth.
// A heading is the keyword at the start of a line, optionally behind a markdown heading
// marker or bold, and followed by a delimiter, so "DO NOT touch" and "GOALS" are prose.
const heading = (words: string) => new RegExp(`^[ \\t]*(?:#{1,6}[ \\t]+)?\\*{0,2}(?:${words})(?=\\*{0,2}(?:[:.,(]|[ \\t]*$)|[ \\t]+\\()`, "m");
const PARTS: Array<{ name: string; heading: RegExp }> = [
  { name: "GOAL", heading: heading("GOAL") },
  { name: "DO", heading: heading("DO") },
  { name: "OUT OF SCOPE", heading: heading("OUT OF SCOPE") },
  { name: "DONE WHEN", heading: heading("DONE WHEN") },
  { name: "DECIDED or RULES", heading: heading("DECIDED|RULES") },
];

/** A warning naming the headed parts `body` lacks, or null when it has all five. */
export function missingPartsWarning(body: string): string | null {
  const prose = proseOnly(body);
  const missing = PARTS.filter((part) => !part.heading.test(prose)).map((part) => part.name);
  if (missing.length === 0) return null;
  return `the body has no heading for: ${missing.join(", ")}. Posted anyway. A session acts best on a body with GOAL, DO, OUT OF SCOPE, DONE WHEN and DECIDED or RULES (docs/work-queue.md, "A body a session can act on").`;
}
