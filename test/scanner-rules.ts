// FINDS THE TESTS THAT READ src/ AS TEXT, so test/scanner-rules.test.ts can require each
// to name the rule it enforces (job_3e1596235513).
//
// A test file is cut into top-level chunks at every line that starts a declaration or a
// test at column 0. A chunk reads source if it calls a helper from ./source-files.ts or
// reads a path under src/, or if it names a module-level constant or function that does,
// found by repeating until nothing new is tainted. Imports are not chunks, so importing a
// module from src/ to call it is not reading it.

const SEED = [
  /\b(sourceFile|sourceFiles|allSourceText|toolBlocks)\s*\(/,
  // A path under src/ that is read, not imported: a dynamic import() and an import
  // statement quoted as a fixture both name the path without reading its text.
  /(?<!(?:from|import)\s*|import\()["']\.\.\/src\//,
  /["']\.\.["']\s*,\s*["']src["']/,
];

const CHUNK_START = /^(test\(|for \(|(export )?(async )?function |(export )?(const|let) )/;
const DECLARED = /^(?:export )?(?:async )?(?:function\*?\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/;

export interface Chunk {
  start: number;
  text: string;
  isTest: boolean;
  name: string | null;
}

export function chunks(source: string): Chunk[] {
  const lines = source.split("\n");
  const out: Chunk[] = [];
  let current: { start: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    // Comment lines are dropped, so prose that names a helper does not count as a read.
    const text = current.lines.filter((line) => !line.trim().startsWith("//")).join("\n");
    const first = current.lines[0];
    out.push({
      start: current.start,
      text,
      isTest: /^test\(/.test(first) || (/^for \(/.test(first) && /\btest\(/.test(text)),
      name: DECLARED.exec(first)?.[1] ?? null,
    });
  };
  lines.forEach((line, i) => {
    if (CHUNK_START.test(line)) {
      flush();
      current = { start: i, lines: [line] };
    } else if (/^(import |describe\(|\/\/)/.test(line)) {
      flush();
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  });
  flush();
  return out;
}

// The comment block directly above a line, as one string.
function commentAbove(lines: string[], index: number): string {
  const above: string[] = [];
  for (let i = index - 1; i >= 0 && lines[i].startsWith("//"); i--) above.unshift(lines[i]);
  return above.join("\n");
}

/** The first line of every test that reads src/ as text and carries no scanner-rule. */
export function unmarkedScanners(source: string): { scanners: number; unmarked: string[] } {
  const all = chunks(source);
  const tainted = new Set<string>();
  const reads = (text: string) =>
    SEED.some((pattern) => pattern.test(text)) || [...tainted].some((name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text));
  for (let changed = true; changed; ) {
    changed = false;
    for (const chunk of all) {
      if (chunk.isTest || !chunk.name || tainted.has(chunk.name)) continue;
      if (reads(chunk.text)) {
        tainted.add(chunk.name);
        changed = true;
      }
    }
  }
  const lines = source.split("\n");
  const scanners = all.filter((chunk) => chunk.isTest && reads(chunk.text));
  const unmarked = scanners
    .filter((chunk) => !/scanner-rule:/.test(commentAbove(lines, chunk.start)))
    .map((chunk) => lines[chunk.start].slice(0, 100));
  return { scanners: scanners.length, unmarked };
}
