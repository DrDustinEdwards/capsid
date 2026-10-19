import { parsePrUrl, resolveRepo } from "./github/client";
import { readPrFiles } from "./github/pr-files";
import type { Env } from "./env";
import { riskOf, type Risk } from "./model-routing";

// The risk of the pull request a job already carries, read at claim so a job that came
// back for a correction is routed on what it actually changed (riskOf in
// src/model-routing.ts). Every page of files, read-only, through the one reader
// (src/github/pr-files.ts). A pull request whose files were not read whole is high
// risk, never silently routine, and the note says why.

const unknownRisk = (reason: string, read: Risk | null): Risk => ({
  level: "high",
  reasons: [reason, ...(read?.level === "high" ? read.reasons : [])].slice(0, 12),
  files_read: read?.files_read ?? 0,
});

export async function pullRequestRisk(env: Env, namespace: string, ref: string | null): Promise<{ risk: Risk | null; note: string | null }> {
  const pr = parsePrUrl(ref);
  if (!pr) return { risk: null, note: null };
  try {
    const { owner, repo } = await resolveRepo(env, namespace, `${pr.owner}/${pr.repo}`);
    const files = await readPrFiles(env, owner, repo, pr.number);
    const risk = riskOf(files.rows);
    if (files.problem) {
      return { risk: unknownRisk(`the files of ${ref} were not read whole`, risk), note: `routing could not read every file of ${ref} (${files.problem}), so the job was routed as high risk` };
    }
    if (risk.level === "unread") return { risk: unknownRisk(`no changed files of ${ref} were read`, risk), note: `routing read no changed files of ${ref}, so the job was routed as high risk` };
    return { risk, note: null };
  } catch (err) {
    return { risk: unknownRisk(`the files of ${ref} could not be read`, null), note: `routing could not read ${ref}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}, so the job was routed as high risk` };
  }
}
