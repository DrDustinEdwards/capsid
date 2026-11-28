// Same-file overlaps between open pull requests, for the board (src/board.ts). It informs and
// never refuses.

export interface PrOverlap {
  pr: number;
  other: number;
  files: string[];
}

interface PrPaths {
  number: number;
  paths: string[];
}

/**
 * The files each named pull request shares with each other pull request, the older
 * (lower-numbered) first. A named pull request is never compared with itself or with another
 * named one.
 */
export function overlapsOf(named: PrPaths[], others: PrPaths[]): PrOverlap[] {
  const namedNumbers = new Set(named.map((n) => n.number));
  const found: PrOverlap[] = [];
  for (const mine of named) {
    const mineSet = new Set(mine.paths);
    for (const other of others) {
      if (namedNumbers.has(other.number)) continue;
      const files = [...new Set(other.paths.filter((p) => mineSet.has(p)))].sort();
      if (files.length > 0) found.push({ pr: mine.number, other: other.number, files });
    }
  }
  return found.sort(
    (a, b) => Math.min(a.pr, a.other) - Math.min(b.pr, b.other) || a.pr - b.pr || a.other - b.other,
  );
}
