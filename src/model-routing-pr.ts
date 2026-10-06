import { ghFetch, parsePrUrl, resolveRepo } from "./github/client";
import type { Env } from "./env";
import { riskOf, type ChangedFile, type Risk } from "./model-routing";

// The risk of the pull request a job already carries, read at claim so a job that came
// back for a correction is routed on what it actually changed (riskOf in
// src/model-routing.ts). One page of files, read-only. A failed read is reported back as
// a note and routes the job on what the job says about itself, never silently as routine.

const FILES_PER_PAGE = 100;

export async function pullRequestRisk(env: Env, namespace: string, ref: string | null): Promise<{ risk: Risk | null; note: string | null }> {
  const pr = parsePrUrl(ref);
  if (!pr) return { risk: null, note: null };
  try {
    const { owner, repo } = await resolveRepo(env, namespace, `${pr.owner}/${pr.repo}`);
    const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=${FILES_PER_PAGE}`);
    if (!resp.ok) return { risk: null, note: `routing could not read the files of ${ref} (${resp.status}), so the job was routed on its own text` };
    const files = (await resp.json()) as ChangedFile[];
    const risk = riskOf(Array.isArray(files) ? files : []);
    const more = Array.isArray(files) && files.length >= FILES_PER_PAGE ? `; only the first ${FILES_PER_PAGE} files were read` : "";
    return { risk, note: more ? `routing read the first page of ${ref}${more}` : null };
  } catch (err) {
    return { risk: null, note: `routing could not read ${ref}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}, so the job was routed on its own text` };
  }
}
