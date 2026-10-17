import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { CodeMapSchema, type PublicCode } from "./public-code-schema";
import { publicRepos, type RepoPrivacy, type SystemModel } from "./system-model";

// The public code maps (design capsid/research/design-system-explorer.md, section 5;
// docs/public-data.md). devkit's code-map workflow writes code-map.json to an orphan
// `code-map` branch in each repo that calls it. The daily public build reads that file
// for every repo of a public system, parses it into new objects here, and stores the
// lot as one document for the explorer's build. A repo of a private system is never
// read, so its map cannot be published.

const BRANCH = "code-map";
const FILE = "code-map.json";
// Capsid's own map is the largest, a few thousand functions; a file far past that is
// not one devkit wrote.
const MAX_FILE_BYTES = 8_000_000;

/** The repo's code-map.json from its code-map branch, or null when the repo has none
 *  (no branch, no file). Any other failure throws. */
export async function readCodeMap(env: Env, repoFull: string): Promise<unknown> {
  const [owner, repo] = repoFull.split("/");
  const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/contents/${FILE}?ref=${BRANCH}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`code map read failed for ${repoFull} (${resp.status})`);
  const text = await resp.text();
  if (text.length > MAX_FILE_BYTES) throw new Error(`code map for ${repoFull} is ${text.length} bytes, over ${MAX_FILE_BYTES}`);
  return JSON.parse(text);
}

/**
 * Reads and parses the code map of every repo of a public system. A repo with no map is
 * left out; a map that fails the schema, or names another repo, throws, so the build keeps
 * the last good document rather than publish one it did not check.
 */
export async function buildPublicCode(
  env: Env,
  model: SystemModel,
  privacy: RepoPrivacy,
  asOf: string,
  read: (env: Env, repo: string) => Promise<unknown> = readCodeMap
): Promise<PublicCode> {
  const maps: PublicCode["maps"] = [];
  for (const { system, repo } of publicRepos(model, privacy)) {
    const raw = await read(env, repo);
    if (raw === null) continue;
    const parsed = CodeMapSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`code map for ${repo} is invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (parsed.data.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`code map on ${repo} names ${parsed.data.repo}`);
    maps.push({ ...parsed.data, repo, system });
  }
  return { version: 1, as_of: asOf, maps };
}
