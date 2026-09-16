// THE SCORER SURFACE THAT IS MEANT TO BE THE SAME IN EVERY ROSTER REPO.
//
// The score job below the marker, and scripts/improve-report.mjs whole, are copied
// verbatim from this repo to the other four by scripts/sync-scorer.mjs. Nothing
// enforced that they stayed copied. On 2026-09-16 the five were measured for the
// first time: THREE distinct score blocks and two distinct report scripts, after a
// copier that had thrown on every run since 2026-09-12 and three commits to the
// shared surface that reached nobody.
//
// This module is the half of the check that can run in the Worker, which is the
// only thing here with read access to all five repos. The copier keeps its own
// copy of the same logic because it is an offline script with no Worker bindings;
// test/scorer-identity.test.ts runs both over the same input and fails if they
// ever disagree, so the two spellings cannot drift.

import { bytesToHex } from "./encoding";

export const SCORER_MARKER = "BYTE-IDENTICAL BELOW THIS LINE";
export const SCORER_WORKFLOW = ".github/workflows/improve-score.yml";
export const SCORER_REPORT = "scripts/improve-report.mjs";

// A pinned step is `uses: owner/action@<40 hex> # v5`. The SHA is the security
// property and is compared strictly; the trailing comment is an annotation that
// Renovate rewrites per repository, so it is normalized out. Ruled 2026-09-16.
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
 *  or occurs more than once, because either means this file is not the shape the
 *  copier assumes and guessing a split point would compare the wrong bytes. */
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
