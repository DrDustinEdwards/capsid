// Types for the claims export, so test/export-claims.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/export-claims.mjs.
export type Row = Record<string, unknown>;
export type Tool = (name: string, args: object) => Promise<string>;
export interface Manifest {
  generated_at: string;
  origin: string;
  capsid_sha: string;
  tables: Record<string, { file: string; rows: number; sha256: string }>;
}

export const ORIGIN_DEFAULT: string;
export const EXPORT_TABLES: string[];
export const PAGE_LIMIT: number;
export function sha256Hex(data: string | Uint8Array): string;
export function canonicalJson(value: unknown): string;
export function toJsonl(rows: Row[]): string;
export function parsePage(text: string, table: string): { rows: Row[]; next_after: number | null };
export function fetchTable(tool: Tool, table: string): Promise<Row[]>;
export function ensureEmptyDir(dir: string): void;
export function fetchCapsidSha(origin: string, fetchImpl?: typeof fetch): Promise<string>;
export function exportClaims(opts: { tool: Tool; origin: string; capsidSha: string; outDir: string; now?: Date }): Promise<Manifest>;
// Every problem with an export directory; an empty list means it verified.
export function verifyExport(dir: string): string[];
export function scrub(text: string, key: string | undefined): string;
export function parseArgs(argv: string[]): { out: string | undefined; verify: string | undefined };
// The whole command with its outputs injected. Returns the exit code.
export function run(opts: {
  argv: string[];
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
}): Promise<number>;
