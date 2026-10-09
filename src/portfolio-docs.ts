// The portfolio documents every namespace driver may READ in capsid, and nothing else
// there.
//
// Every repo's CLAUDE.md tells a session to follow capsid/conventions.md, the rulings
// and the decisions log, but a driver minted for one namespace was refused all of
// them, so it worked from its repo's CLAUDE.md and the job bodies alone. This is the
// one statement of what crosses that boundary. checkScope (src/scope.ts) admits a read
// of a path matched here, the list, find and search handlers drop every other capsid
// row for such a caller, and brief names the documents that exist. Nothing else in
// capsid (research, policy, jobs, reports, episodics) is reachable, and no write is.
//
// test/portfolio-docs.test.ts pins this constant.
export const PORTFOLIO_DOCS = {
  namespace: "capsid",
  // Exact paths.
  documents: ["conventions.md", "core.md", "decisions.md"],
  // A decisions volume: the prefix, then a volume number, then ".md". The live log
  // opens decisions-vol-<n>.md when decisions.md reaches its cap, and a closed volume
  // moves to archive/decisions-vol-<n>.md.
  volumes: ["decisions-vol-", "archive/decisions-vol-"],
  // One document directly inside the folder, no deeper.
  folders: ["rulings/"],
  // The tools that may reach capsid for such a caller. Each requires only the read
  // grant (TOOL_GRANTS). history and backlinks stay out: a version list or an edge can
  // name a capsid path that is not on this list.
  tools: ["read", "list", "find", "search"],
} as const;

// A path is matched against this before anything else: lowercase letters, digits, dot,
// dash, underscore and slash only. So a percent-encoding, a backslash, a space or a
// capital letter cannot reach a comparison, whatever the database or a later decoder
// would make of it. Stored paths are case-sensitive, and every portfolio path is
// lowercase.
const SAFE_PATH = /^[a-z0-9][a-z0-9._/-]*$/;
const VOLUME = /^[1-9][0-9]{0,3}\.md$/;
const FOLDER_ENTRY = /^[a-z0-9][a-z0-9._-]*\.md$/;

/** Whether a capsid path is one of the portfolio documents. */
export function isPortfolioPath(path: string): boolean {
  if (typeof path !== "string" || !SAFE_PATH.test(path)) return false;
  // No traversal and no empty segment, even though nothing here resolves a path: the
  // test is on the string, and "rulings/../policy/gates.md" must not read as rulings/.
  if (path.includes("..") || path.includes("//") || path.endsWith("/")) return false;
  if ((PORTFOLIO_DOCS.documents as readonly string[]).includes(path)) return true;
  for (const prefix of PORTFOLIO_DOCS.volumes) {
    if (path.startsWith(prefix) && VOLUME.test(path.slice(prefix.length))) return true;
  }
  for (const folder of PORTFOLIO_DOCS.folders) {
    if (path.startsWith(folder) && FOLDER_ENTRY.test(path.slice(folder.length))) return true;
  }
  return false;
}

/** Whether a tool may reach the portfolio documents for a caller outside capsid. */
export function isPortfolioTool(tool: string): boolean {
  return (PORTFOLIO_DOCS.tools as readonly string[]).includes(tool);
}

/** The allowlist as a reader sees it, for a refusal and for brief. */
export function describePortfolioDocs(): string[] {
  return [
    ...PORTFOLIO_DOCS.documents,
    ...PORTFOLIO_DOCS.volumes.map((v) => `${v}<n>.md`),
    ...PORTFOLIO_DOCS.folders.map((f) => `${f}<name>.md`),
  ];
}

export interface PortfolioRow {
  namespace: string;
  path: string;
  title: string | null;
  type: string | null;
  status: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

/** The portfolio documents that exist, metadata only, ordered by path. The query
 *  narrows by the exact paths and a GLOB per volume prefix and folder; isPortfolioPath
 *  then decides, so the GLOB's looser match (a nested rulings path, a non-numeric
 *  volume) never reaches a caller. */
export async function portfolioDocuments(db: D1Database): Promise<PortfolioRow[]> {
  const globs = [...PORTFOLIO_DOCS.volumes, ...PORTFOLIO_DOCS.folders].map((p) => `${p}*`);
  const { results } = await db
    .prepare(
      `SELECT namespace, path, title, type, status, tags, created_at, updated_at
       FROM documents
       WHERE namespace = ?1
         AND (path IN (SELECT value FROM json_each(?2)) OR EXISTS (SELECT 1 FROM json_each(?3) AS g WHERE documents.path GLOB g.value))
       ORDER BY path`
    )
    .bind(PORTFOLIO_DOCS.namespace, JSON.stringify(PORTFOLIO_DOCS.documents), JSON.stringify(globs))
    .all<PortfolioRow>();
  return results.filter((r) => isPortfolioPath(r.path));
}
