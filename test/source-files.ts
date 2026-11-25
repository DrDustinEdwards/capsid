import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

// The source walk shared by every scanner: one definition of "the source" and one vacuity guard, so a guard's scope is
// not an assumption about where the next offender is written.

const SRC_DIR = join(import.meta.dirname, "..", "src");

export interface SourceFile {
  name: string;
  text: string;
}

// A floor, not a count: an empty walk fails loudly instead of making every downstream assertion vacuously true.
const MIN_SOURCE_FILES = 10;

// Recursive, so a tool moved into a subdirectory cannot hide; names are root-relative with forward slashes (tools/documents.ts).
function collectSourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        out.push({
          name: full
            .slice(root.length + 1)
            .split(sep)
            .join("/"),
          text: readFileSync(full, "utf8"),
        });
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
        `Either the directory moved or the walk is broken; every source guard that reads through here is now scanning nothing.`,
    );
  }
  return files;
}

// Every source file concatenated with a per-file banner; use sourceFiles() when a finding has to name its file.
export function allSourceText(): string {
  return sourceFiles()
    .map((f) => `// ===== ${f.name} =====\n${f.text}`)
    .join("\n");
}

export function sourceFile(name: string): string {
  const found = sourceFiles().find((f) => f.name === name);
  if (!found) throw new Error(`src/${name} not found by the source walk`);
  return found.text;
}

export interface SourceExport {
  file: string;
  name: string;
}

// Every exported binding in src/, by name; types are excluded because a type has no runtime caller and removing one is a compile error.
export function exportsOfSrc(): SourceExport[] {
  const out: SourceExport[] = [];
  for (const file of sourceFiles()) {
    for (const m of file.text.matchAll(
      /^export (?:async )?(?:function|const|class) ([A-Za-z0-9_]+)/gm,
    )) {
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

// Each registerTool call, scanned per FILE so a block cannot run into the next module's text and a failure names its file.
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

// Each operation's definition (src/tools/operations.ts). The served tools dispatch to these, so what a handler DOES is
// read here and attributed to its tools and actions with servedAs().
export function operationBlocks(): ToolBlock[] {
  const marker = "ctx.ops.define(";
  const blocks: ToolBlock[] = [];
  for (const { name, text } of sourceFiles()) {
    const starts: number[] = [];
    for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) starts.push(i);
    for (let i = 0; i < starts.length; i++) {
      const body = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length);
      blocks.push({
        file: name,
        body,
        name: body.match(/ops\.define\(\s*\n?\s*"([^"]+)"/)?.[1] ?? `${name}#${i}`,
      });
    }
  }
  return blocks;
}
