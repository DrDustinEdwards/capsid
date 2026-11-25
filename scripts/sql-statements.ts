// Every SQL statement in src/, extracted from the source by a walk, because a hand-maintained catalog misses the next query.
// It reads the argument of every `.prepare(...)` call (a regex over source text, not a TypeScript parse). A template literal with a `${...}` hole keeps the hole replaced by a placeholder valid SQL where one can be guessed (table name, placeholder list, column list) and is skipped otherwise;
// skipped ones are returned so a caller can assert how many, and a plan check cannot quietly cover only some statements.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Not global: a global regex keeps lastIndex across .test() calls, so the next statement's test would start mid-string and could miss its hole.
const HOLE = /\$\{[^}]*\}/;

function substitute(sql: string): { ok: boolean; sql: string } {
  if (!HOLE.test(sql)) return { ok: true, sql };
  // A hole immediately after FROM or INTO or JOIN is a table name.
  let out = sql.replace(/\b(FROM|INTO|JOIN|UPDATE)\s+\$\{[^}]*\}/gi, "$1 documents");
  // A hole where a whole WHERE clause goes is an optional filter list; a tautology stands in so the statement plans (an optional filter only narrows the scan).
  out = out.replace(/\$\{clause\}|\$\{where[A-Za-z]*\}/g, "WHERE 1 = 1");
  // A hole after a `?` is a bound-parameter index; any index plans the same.
  out = out.replace(/\?\$\{[^}]*\}/g, "?1");
  // A hole inside a VALUES or IN list is a placeholder list.
  out = out.replace(/\(\s*\$\{[^}]*\}\s*\)/g, "(?1)");
  // A remaining hole in a projection position.
  out = out.replace(/SELECT\s+\$\{[^}]*\}/gi, "SELECT *");
  if (HOLE.test(out)) return { ok: false, sql };
  return { ok: true, sql: out };
}

/**
 * Recursive, because src/ has subdirectories. Names are relative to srcDir with forward slashes, so a top-level file keeps its basename
 * (backup.ts, which the ALLOW list keys on) and a nested one reads github/client.ts.
 */
function tsFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const dir = rel ? join(root, rel) : root;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts")) out.push(next);
    }
  };
  walk("");
  return out.sort();
}

// An index signature too: these cross into miniflare as a JSON binding, which requires one. Both readers narrow to file and sql.
export interface ExtractedStatement {
  [key: string]: string;
  file: string;
  sql: string;
}

export function extractStatements(srcDir: string): {
  statements: ExtractedStatement[];
  skipped: ExtractedStatement[];
} {
  const statements: ExtractedStatement[] = [];
  const skipped: ExtractedStatement[] = [];
  for (const name of tsFilesUnder(srcDir)) {
    const text = readFileSync(join(srcDir, name), "utf8");
    // `.prepare(` followed by a string or template literal up to its closing quote, in any quote style; line comments between `.prepare(` and the string are skipped (several statements carry one).
    const calls = text.matchAll(
      /\.prepare\(\s*(?:\/\/[^\n]*\n\s*)*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    );
    for (const call of calls) {
      const raw = call[1];
      const body = raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'");
      const collapsed = body.replace(/\s+/g, " ").trim();
      if (collapsed.length === 0) continue;
      const substituted = substitute(collapsed);
      if (substituted.ok) statements.push({ file: name, sql: substituted.sql });
      else skipped.push({ file: name, sql: collapsed });
    }
    // `.prepare(<expression>)`: the SQL is chosen at run time, so there is no literal. Counted as skipped so a caller asserting the skipped count sees it.
    for (const call of text.matchAll(/\.prepare\(\s*(?:\/\/[^\n]*\n\s*)*([^\s`"'/][^\n]*)/g)) {
      skipped.push({ file: name, sql: `(expression) ${call[1].trim()}` });
    }
  }
  return { statements, skipped };
}
