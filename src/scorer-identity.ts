// The scorer surface that must be the same in every roster repo: the score job below
// the marker, and scripts/improve-report.mjs whole, copied by scripts/sync-scorer.mjs.
// This is the Worker's half of the identity check. The copier keeps its own copy of
// the logic (it has no Worker bindings); test/scorer-identity.test.ts runs both over
// the same input.

import { bytesToHex } from "./encoding";

export const SCORER_MARKER = "BYTE-IDENTICAL BELOW THIS LINE";
export const SCORER_WORKFLOW = ".github/workflows/improve-score.yml";
export const SCORER_REPORT = "scripts/improve-report.mjs";

// A pinned step is `uses: owner/action@<40 hex> # v5`. The SHA is the security
// property and is compared strictly; the trailing comment is an annotation that
// Renovate rewrites per repository, so it is normalized out.
const PIN_LINE = /^(\s*-?\s*uses:\s*[^\s@]+@[0-9a-f]{40})(\s*#.*)?\s*$/;

export function normalizePins(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const m = PIN_LINE.exec(line);
      return m ? m[1] : line;
    })
    .join("\n");
}

/** The shared block: the marker line to end of file. Null when the marker is absent
 *  or occurs more than once, rather than guessing a split point. */
export function sharedBlock(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.reduce<number[]>((acc, line, i) => (line.includes(SCORER_MARKER) ? [...acc, i] : acc), []);
  if (at.length !== 1) return null;
  return lines.slice(at[0]).join("\n");
}

/** sha256 of the text with line endings normalized, matching blockHash in
 *  scripts/sync-scorer.mjs byte for byte. Truncated by the caller for display. */
export async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, "\n"));
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}
