// Types for the MCP 4 migration rules, so tests type-check under tsconfig.test.json.
// The runtime is scripts/tool-names-lib.mjs.
export const SIMPLE: Record<string, [string, string | null]>;
export const RENAMED: Record<string, string>;
export const RENAMED_ACTIONS: Record<string, string[]>;
export const SPLIT: Record<string, Record<string, [string, string]>>;
export const OLD_TOOLS: string[];
export const OLD_ACTIONS_OF: Record<string, Set<string>>;
export function grantsOf(entry: string, list: readonly string[]): Array<[string, string]> | null;
export function newToolsAxis(list: "*" | readonly string[]): "*" | string[];
export function isOldEntry(entry: string): boolean;
export function addedToolsAxis(list: "*" | readonly string[]): "*" | string[];
export function prunedToolsAxis(list: "*" | readonly string[]): "*" | string[];
export function renamed(tool: string, action: string | undefined, called?: boolean): { tool: string; action: string | null } | null;
export function rewriteProse(text: string): {
  text: string;
  changes: Array<{ line: number; before: string; after: string }>;
  fenced: Array<{ line: number; text: string }>;
  unmapped: Array<{ line: number; text: string }>;
  ambiguous: Array<{ line: number; text: string }>;
};
export function unsignedBody(stored: string): string;
