// Types for the MCP 4 migration script, so tests type-check under tsconfig.test.json.
// The runtime is scripts/migrate-tool-names.mjs.
type Tool = (name: string, args: object) => Promise<string>;
export function parseArgs(argv: string[]): { phase?: string; surface?: string; apply: boolean };
export function migrateAxes(tool: Tool, surface: "old" | "new", phase: "add" | "prune", apply: boolean, out: (line: string) => void): Promise<number>;
export function migrateProse(tool: Tool, apply: boolean, out: (line: string) => void): Promise<number>;
