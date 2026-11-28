import type { RepoEnv as Env } from "../env";
import { assertRepoArg, getDefaultBranch, getRefSha, ghFetch, resolveRepo } from "./client";
import { readRepoFile } from "./contents";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// Served as capsid_close_pr actions tag and release, which need can_merge (src/scope.ts
// repoWriteFlags): a tag or release can start a deploy. A release is refused when its CHANGELOG has
// no section for the tag.

// Narrower than git allows, on purpose.
const TAG = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const SHA = /^[0-9a-f]{40}$/;
const NOTES_MAX = 50_000;

export function tagRefusal(tag: string): string | null {
  return TAG.test(tag)
    ? null
    : `'${tag}' is not a release tag: use a version such as v1.4.0 or 1.4.0-rc.1.`;
}

export function changelogSection(markdown: string, tag: string): string | null {
  const version = tag.replace(/^v/, "");
  const escaped = version.replace(/[.+]/g, (c) => `\\${c}`);
  const names = new RegExp(`^(#{1,6})\\s+\\[?v?${escaped}\\]?(?:\\s|$|\\]|\\))`);
  const lines = markdown.split(/\r?\n/);
  let level = 0;
  const out: string[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (level === 0) {
      const found = names.exec(line);
      if (found) level = found[1].length;
      continue;
    }
    if (heading && heading[1].length <= level) break;
    out.push(line);
  }
  const body = out.join("\n").trim();
  return level > 0 && body.length > 0 ? body : null;
}

export interface TagReleaseArgs {
  tag: string;
  sha?: string;
  ref?: string;
  publishRelease: boolean;
  changelogPath: string;
}

export async function tagRelease(
  env: Env,
  namespace: string,
  args: TagReleaseArgs,
  repoSelector?: string,
) {
  const badTag = tagRefusal(args.tag);
  if (badTag) throw new Error(badTag);
  assertRepoArg("changelog", args.changelogPath);
  if (args.sha !== undefined && !SHA.test(args.sha))
    throw new Error("sha must be a full 40-character commit sha.");
  if (args.sha !== undefined && args.ref !== undefined)
    throw new Error("pass sha or ref, not both.");
  if (args.ref !== undefined) assertRepoArg("ref", args.ref);
  const { owner, repo, full } = await resolveRepo(env, namespace, repoSelector);
  const sha =
    args.sha ??
    (await getRefSha(env, owner, repo, args.ref ?? (await getDefaultBranch(env, owner, repo))));

  // The notes first, at the tagged commit, so a release with no section writes nothing.
  let notes: string | null = null;
  if (args.publishRelease) {
    const file = await readRepoFile(env, namespace, args.changelogPath, sha, repoSelector);
    notes = releaseNotes(file.content, args.tag);
    if (!notes) {
      throw new Error(
        `${args.changelogPath} at ${sha.slice(0, 7)} has no section for ${args.tag}. Add one (a heading naming the version), merge it, and release that commit. Nothing was tagged.`,
      );
    }
  }

  await createTag(env, owner, repo, args.tag, sha);
  if (!notes) return { repo: full, tag: args.tag, sha, release: null };

  let release: { id: number; url: string };
  try {
    release = await publishRelease(env, owner, repo, args.tag, notes);
  } catch (err) {
    throw new Error(
      `the tag ${args.tag} was created at ${sha.slice(0, 7)} but the release was not (${errorMessage(err)}). ` +
        `Publish it from the tag on GitHub, or delete the tag and release again.`,
    );
  }
  return {
    repo: full,
    tag: args.tag,
    sha,
    release: { id: release.id, url: release.url, notes_chars: notes.length },
  };
}

function releaseNotes(markdown: string, tag: string): string | null {
  const notes = changelogSection(markdown, tag);
  if (!notes) return null;
  return notes.length > NOTES_MAX
    ? `${notes.slice(0, NOTES_MAX)}\n\n(The CHANGELOG section continues past ${NOTES_MAX} characters.)`
    : notes;
}

/** Never moves a tag: GitHub's 422 for an existing ref is thrown saying nothing changed. */
async function createTag(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
  sha: string,
): Promise<void> {
  const badTag = tagRefusal(tag);
  if (badTag) throw new Error(badTag);
  if (!SHA.test(sha)) throw new Error("sha must be a full 40-character commit sha.");
  const tagged = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
  });
  if (!tagged.ok) {
    const detail = await tagged.text();
    if (tagged.status === 422)
      throw new Error(
        `tag ${tag} already exists in ${owner}/${repo}, or the commit is unknown. Nothing was changed. Detail: ${detail.slice(0, 300)}`,
      );
    throw new Error(`tag failed (${tagged.status}): ${detail.slice(0, 300)}`);
  }
}

async function publishRelease(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
  notes: string,
): Promise<{ id: number; url: string }> {
  const released = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: notes,
      draft: false,
      prerelease: /-/.test(tag),
    }),
  });
  if (!released.ok) throw new Error(`${released.status}: ${(await released.text()).slice(0, 300)}`);
  const release = (await released.json()) as { id: number; html_url: string };
  return { id: release.id, url: release.html_url };
}
