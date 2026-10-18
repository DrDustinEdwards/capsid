import type { Env } from "./env";
import { base64Decode } from "./encoding";
import { ghFetch, getDefaultBranch } from "./github/client";
import { createTag, publishRelease, releaseNotes } from "./github/releases";
import type { MaintenanceItem } from "./maintenance";
import { readRootManifest, readSharedConfig, releaseDecision } from "./shared-code";
import { auditStatement } from "./store-guards";

// The daily maintenance pass's release-tag rule (Capsid improvement list, item 13:
// releases without Dustin's PC). A cloud session cannot push a tag, so a shared package's
// version bump merged from one sat untagged until he tagged it at his desk, and every
// package repo's bump-consumers workflow (on push: tags: v*) waited with it. Merging the
// bump is the release decision; this rule makes the tag that follows from it.
//
// For each shared package (shared_packages, migrations/0036; the Shared code view's
// configuration, src/shared-code.ts) the version in the repo's root package.json on its
// default branch is compared with the repo's tags by releaseDecision, the rule the view
// uses for "untagged":
// - a version a tag already names is left alone;
// - a version newer than every release tag is tagged v<version> at the commit that set
//   it: walking the commits that touched package.json, newest first, the oldest of the
//   run that carries this version. Not the newest such commit: a later dependency change
//   that kept the version is not the release. When the run reaches the end of what was
//   read (COMMITS_READ) and the file's history is longer, the commit is not known, and
//   the version is listed rather than tagged at a guess;
// - a version below the newest release tag is never tagged (it would start
//   bump-consumers on an older version) and is listed;
// - a pre-release or missing version is left for a person.
// A tag made through the App's installation token fires push workflows (only events
// made with a workflow's own GITHUB_TOKEN are suppressed), so the tag starts
// bump-consumers in the package repo, which opens the apps' bump pull requests.
//
// Tag, and a release only when the CHANGELOG has a section for the version: the notes
// are then the package's own words (src/github/releases.ts, releaseNotes, the rule
// capsid_close_pr action release applies). With no section the tag alone is made, since
// a release with empty or guessed notes is what that action refuses. A failed release
// after a made tag is listed, never retried by retagging.
//
// On by default, unlike the branch prune: a tag adds and never removes, GitHub refuses a
// tag that exists (so nothing is retagged or moved), and the decision was the merge. The
// seat turns it off by setting RELEASE_TAGS_SWITCH_KEY to "off"; off, what would be
// tagged is listed. At most RELEASE_TAG_CAP tags per run; the rest wait for the next.
// Each tag is audit-logged, before the next, with the repo, tag and sha (CLAUDE.md,
// snapshot rule: a write leaves its record). A system action of the pass, like the
// branch prune, so it takes no caller's grant; the writes are the ones guardedWrite
// files for capsid_close_pr action tag and release, through the same helpers.

/** The switch the seat sets to "off" to stop the pass tagging. Anything else, or no key,
 *  is on. A KV key rather than a control, as the prune switch is
 *  (src/maintenance-branches.ts): a control would add to a served tool's surface. */
export const RELEASE_TAGS_SWITCH_KEY = "maintenance:release-tags";
export const RELEASE_TAG_CAP = 3;
export const RELEASE_TAG_AUDIT_ACTION = "maintenance-release-tag";
// Commits that touched package.json read per package, newest first.
export const COMMITS_READ = 20;
const CHANGELOG_PATH = "CHANGELOG.md";
const TAGS_PER_PAGE = 100;
const SYSTEM_ACTOR = "system:maintenance";

export interface ReleasePackage {
  name: string;
  repo: string;
  /** The namespace whose repos include the package's repo, for the item and the audit
   *  row; "capsid", which keeps the configuration, when none does. */
  namespace: string;
}

export interface ReleaseReaders {
  /** The configured shared packages. Throws when the table could not be read. */
  packages(): Promise<ReleasePackage[]>;
  /** The root package.json's version on the default branch, and that branch. */
  head(repo: string): Promise<{ version: string | null; branch: string }>;
  /** The repo's tag names (one page). */
  tags(repo: string): Promise<string[]>;
  /** The commits on `branch` that touched package.json, newest first, at most `limit`;
   *  complete when fewer came back, so the file's whole history was read. */
  manifestCommits(repo: string, branch: string, limit: number): Promise<{ shas: string[]; complete: boolean }>;
  /** The root package.json's version at a commit. */
  versionAt(repo: string, sha: string): Promise<string | null>;
  /** CHANGELOG.md at a commit, or null when there is none. */
  changelog(repo: string, sha: string): Promise<string | null>;
  tag(repo: string, tag: string, sha: string): Promise<void>;
  /** Publish the tag's release; its URL. */
  release(repo: string, tag: string, notes: string): Promise<string>;
}

/**
 * The commit that set `version`, from the commits that touched package.json, newest first,
 * each with the version it carries: the oldest of the leading run that carries it. Null
 * when the newest does not carry it, or the run reaches the end of an incomplete read.
 */
export function versionCommit(history: ReadonlyArray<{ sha: string; version: string | null }>, version: string, complete: boolean): string | null {
  if (history.length === 0 || history[0].version !== version) return null;
  let i = 0;
  while (i + 1 < history.length && history[i + 1].version === version) i++;
  if (i + 1 < history.length) return history[i].sha;
  return complete ? history[i].sha : null;
}

/** The release-tag rule over every shared package, how many were read, and how many tagged. */
export async function gatherReleaseItems(env: Env, readers: ReleaseReaders): Promise<{ items: MaintenanceItem[]; read: number; tagged: number }> {
  const items: MaintenanceItem[] = [];
  let read = 0;
  let tagged = 0;

  let on: boolean;
  let packages: ReleasePackage[];
  try {
    on = (await env.APP_KV.get(RELEASE_TAGS_SWITCH_KEY)) !== "off";
    packages = await readers.packages();
  } catch (err) {
    return { items: [notChecked("capsid", `the switch or the shared packages could not be read: ${err instanceof Error ? err.message : String(err)}`)], read, tagged };
  }

  for (const pkg of packages) {
    const { namespace, repo } = pkg;
    let tag: string;
    let sha: string;
    let changelog: string | null;
    try {
      const head = await readers.head(repo);
      const decision = releaseDecision(head.version, await readers.tags(repo));
      read++;
      if (decision.kind === "tagged") continue;
      if (decision.kind === "not-a-release") {
        if (decision.version !== null) items.push({ rule: "release-untagged", namespace, job: null, line: `${repo} is at version ${decision.version}, which is not a plain x.y.z release, so the pass does not tag it: tag it by hand if it is one.` });
        continue;
      }
      if (decision.kind === "backwards") {
        items.push({ rule: "release-backwards", namespace, job: null, line: `${repo} is at version ${head.version} on ${head.branch}, below its newest tag ${decision.newest}, so ${decision.tag} was not made: raise the version past ${decision.newest}.` });
        continue;
      }
      tag = decision.tag;
      if (!on) {
        items.push({ rule: "release-untagged", namespace, job: null, line: `${repo} is at version ${head.version} with no tag; the auto-tag is off (${RELEASE_TAGS_SWITCH_KEY}), so ${tag} was not made.` });
        continue;
      }
      if (tagged >= RELEASE_TAG_CAP) {
        items.push({ rule: "release-untagged", namespace, job: null, line: `${repo} is at version ${head.version} with no tag: it waits for the next run (${RELEASE_TAG_CAP} tags are made per run).` });
        continue;
      }
      const listed = await readers.manifestCommits(repo, head.branch, COMMITS_READ);
      const history: Array<{ sha: string; version: string | null }> = [];
      for (const s of listed.shas) {
        const v = await readers.versionAt(repo, s);
        history.push({ sha: s, version: v });
        if (v !== head.version) break;
      }
      const found = versionCommit(history, decision.tag.slice(1), listed.complete);
      if (!found) {
        items.push({ rule: "release-untagged", namespace, job: null, line: `${repo} is at version ${head.version} with no tag, and the commit that set it was not found in the last ${COMMITS_READ} commits to package.json: tag it by hand.` });
        continue;
      }
      sha = found;
      changelog = await readers.changelog(repo, sha);
    } catch (err) {
      items.push(notChecked(namespace, `${repo}: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }

    try {
      await readers.tag(repo, tag, sha);
    } catch (err) {
      items.push(notChecked(namespace, `${repo} ${tag} was not made: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    tagged++;
    // The release, when the CHANGELOG has a section. Its failure is listed: the tag stands.
    const notes = changelog === null ? null : releaseNotes(changelog, tag);
    let release: string | null = null;
    let releaseError: string | null = null;
    if (notes) {
      try {
        release = await readers.release(repo, tag, notes);
      } catch (err) {
        releaseError = err instanceof Error ? err.message : String(err);
      }
    }
    // One audit row per tag, written before the next tag. A failed write stops the rule
    // and the pass, as the branch prune's does: the next run finds the tag made and
    // makes no other.
    await auditStatement(env.DB, SYSTEM_ACTOR, RELEASE_TAG_AUDIT_ACTION, namespace, null, { repo, package: pkg.name, tag, sha, release, release_error: releaseError }).run();
    const after = release ? ` and its release was published (${release})` : releaseError ? `; its release was not published (${releaseError}): publish it from the tag on GitHub` : ` (no ${CHANGELOG_PATH} section, so no release)`;
    items.push({ rule: "release-tagged", namespace, job: null, line: `${repo} was tagged ${tag} at ${sha}${after}. Its bump-consumers workflow runs on the tag.` });
  }
  return { items, read, tagged };
}

function notChecked(namespace: string, problem: string): MaintenanceItem {
  return { rule: "releases-not-checked", namespace, job: null, line: `Releases were not fully checked (${problem}): what is missing is not a clean result.` };
}

/** The readers on GitHub, through the App: the package's repo by its own name, since a
 *  shared package's repo need not be any namespace's. */
export function githubReleaseReaders(env: Env): ReleaseReaders {
  const split = (full: string) => {
    const [owner, name] = full.split("/");
    return { owner, name };
  };
  const getJson = async (full: string, path: string): Promise<unknown> => {
    const { owner, name } = split(full);
    const resp = await ghFetch(env, owner, name, `/repos/${owner}/${name}${path}`);
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`GitHub answered ${resp.status} for ${full}${path.split("?")[0]}`);
    }
    return resp.json();
  };
  return {
    async packages() {
      const config = await readSharedConfig(env.DB);
      const { results } = await env.DB.prepare("SELECT namespace, repos FROM namespaces LIMIT 200").all<{ namespace: string; repos: string | null }>();
      const owner = new Map<string, string>();
      for (const row of results ?? []) {
        let list: unknown;
        try {
          list = JSON.parse(row.repos ?? "[]");
        } catch {
          continue;
        }
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          const r = (entry as { repo?: unknown })?.repo;
          if (typeof r === "string" && !owner.has(r.toLowerCase())) owner.set(r.toLowerCase(), row.namespace);
        }
      }
      return config.map((c) => ({ name: c.name, repo: c.repo, namespace: owner.get(c.repo.toLowerCase()) ?? "capsid" }));
    },
    async head(repo) {
      const { owner, name } = split(repo);
      const branch = await getDefaultBranch(env, owner, name);
      return { version: (await readRootManifest(env, repo, branch)).version, branch };
    },
    async tags(repo) {
      return ((await getJson(repo, `/tags?per_page=${TAGS_PER_PAGE}`)) as Array<{ name: string }>).map((t) => t.name);
    },
    async manifestCommits(repo, branch, limit) {
      const list = (await getJson(repo, `/commits?sha=${encodeURIComponent(branch)}&path=package.json&per_page=${limit}`)) as Array<{ sha: string }>;
      return { shas: list.map((c) => c.sha), complete: list.length < limit };
    },
    async versionAt(repo, sha) {
      return (await readRootManifest(env, repo, sha)).version;
    },
    async changelog(repo, sha) {
      const { owner, name } = split(repo);
      const resp = await ghFetch(env, owner, name, `/repos/${owner}/${name}/contents/${CHANGELOG_PATH}?ref=${encodeURIComponent(sha)}`);
      if (resp.status === 404) {
        await resp.body?.cancel();
        return null;
      }
      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`GitHub answered ${resp.status} for ${repo}'s ${CHANGELOG_PATH}`);
      }
      const data = (await resp.json()) as { content?: unknown; encoding?: unknown };
      return data.encoding === "base64" && typeof data.content === "string" ? base64Decode(data.content) : null;
    },
    async tag(repo, tag, sha) {
      const { owner, name } = split(repo);
      await createTag(env, owner, name, tag, sha);
    },
    async release(repo, tag, notes) {
      const { owner, name } = split(repo);
      return (await publishRelease(env, owner, name, tag, notes)).url;
    },
  };
}
