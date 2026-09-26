import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

// The source walk, shared by every scanner. Scanning one file would make a guard's
// scope an assumption about where the next offender will be written, and would
// blind the guards when a tool moves to another module.
//
// Everything reads through here so there is one definition of "the source", one
// vacuity guard, and one place to change when src/ grows a subdirectory.

const SRC_DIR = join(import.meta.dirname, "..", "src");

export interface SourceFile {
  name: string;
  text: string;
}

// A floor, not a count: a walk that returns nothing fails loudly instead of making
// every assertion downstream vacuously true. It is well below the real file count so
// adding or removing a module is not a test edit.
const MIN_SOURCE_FILES = 10;

// Recursive, so a tool moved into a subdirectory cannot hide from the guards that
// read through here. The name is the path relative to the root
// with forward slashes, so a top-level file keeps its basename (env.ts) and a
// nested one is addressable (tools/documents.ts). Exported so the recursion
// itself is testable against a fixture tree without touching src/.
export function collectSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        out.push({ name: full.slice(root.length + 1).split(sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function sourceFiles(): SourceFile[] {
  const files = collectSourceFiles(SRC_DIR);
  if (files.length < MIN_SOURCE_FILES) {
    throw new Error(
      `the src/ walk found ${files.length} files, fewer than the ${MIN_SOURCE_FILES} floor. ` +
        `Either the directory moved or the walk is broken; every source guard that reads through here is now scanning nothing.`
    );
  }
  return files;
}

// Every source file concatenated, with a per-file banner so a match can be traced
// back. Use this for counts and presence checks; use sourceFiles() when a finding
// has to name the file it came from.
export function allSourceText(): string {
  return sourceFiles()
    .map((f) => `// ===== ${f.name} =====\n${f.text}`)
    .join("\n");
}

// The text of one named file, for a scanner that is about one module.
export function sourceFile(name: string): string {
  const found = sourceFiles().find((f) => f.name === name);
  if (!found) throw new Error(`src/${name} not found by the source walk`);
  return found.text;
}

export interface SourceExport {
  file: string;
  name: string;
}

// Every exported binding in src/, by name. Functions, consts and classes; types
// and interfaces are deliberately excluded, because a type has no runtime caller
// to find and removing one is a compile error rather than a silent hole. Read by
// test/dead-exports.test.ts and test/lint/dead-exports.lint.ts.
export function exportsOfSrc(): SourceExport[] {
  const out: SourceExport[] = [];
  for (const file of sourceFiles()) {
    for (const m of file.text.matchAll(/^export (?:async )?(?:function|const|class) ([A-Za-z0-9_]+)/gm)) {
      out.push({ file: file.name, name: m[1] });
    }
  }
  return out;
}

export interface ToolBlock {
  name: string;
  body: string;
  file: string;
}

// Each registerTool call, from its name to the start of the next registration.
// Scanned per FILE rather than over a concatenation of all of src/, so a block
// cannot run past the end of its own module and swallow the next file's text, and
// so a failure names the file the offending tool lives in.
export function toolBlocks(): ToolBlock[] {
  const marker = "server.registerTool(";
  const blocks: ToolBlock[] = [];
  for (const { name, text } of sourceFiles()) {
    const starts: number[] = [];
    for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) starts.push(i);
    if (starts.length === 0) continue;
    const resourceStart = text.indexOf("server.registerResource(");
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const bounds = [
        i + 1 < starts.length ? starts[i + 1] : text.length,
        resourceStart > start ? resourceStart : text.length,
      ];
      const body = text.slice(start, Math.min(...bounds));
      blocks.push({
        file: name,
        body,
        name: body.match(/registerTool\(\s*\n?\s*"([^"]+)"/)?.[1] ?? `${name}#${i}`,
      });
    }
  }
  return blocks;
}
