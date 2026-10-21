import type { Env } from "./env";
import { encodePath, ghFetch } from "./github/client";
import { npmVersions, readPackageConfig, type FetchLike } from "./ops-packages";
import { heading, proseOnly } from "./job-body-check";

// The third job body check (src/job-body-check.ts): a body that states a pull request is
// merged, a version is tagged or a package version is published is checked against GitHub
// and npm at post and edit, and refused when what Capsid reads says otherwise. The case:
// a seat told job_d62abdbfc270 that Enarratio 0.3.0 was on npm while it was only staged,
// and the session built on a release that did not exist.
//
// The parser is deliberately narrow, because a false refusal costs more than a miss. It
// reads only prose (proseOnly: code blocks, fences and inline code are exempt), skips the
// DONE WHEN and OUT OF SCOPE parts (they state targets and exclusions, not facts), block
// quotes and text in double quotes, and any sentence that is a question or carries a word
// of plan, condition, negation or report ("once", "will", "not", "said", ...). What is left
// is a claim stated as done: "#12 is merged", "merged #12", "tagged v1.2.0",
// "enarratio@0.3.0 is published", "Enarratio 0.3.0 is on npm".
//
// A claim Capsid could not check (a read failed, the repo is not one the namespace maps,
// the package is not known) is accepted with a warning that says so, never refused. At most
// MAX_CLAIMS claims and MAX_READS network reads are spent on one body.

const MAX_CLAIMS = 10;
const MAX_READS = 20;

export type FactClaim =
  | { kind: "merged"; line: number; said: string; repo: string | null; number: number }
  | { kind: "tagged"; line: number; said: string; name: string | null; version: string }
  // at: written name@version, npm's own spelling. npm: the sentence names npm, or uses it.
  | { kind: "published"; line: number; said: string; name: string | null; at: boolean; npm: boolean; version: string };

// A sentence holding any of these is not a claim stated as done.
const NOT_DONE =
  /\b(?:not|no|never|yet|once|after|before|when|whenever|until|unless|if|whether|will|would|should|shall|must|can|could|may|might|needs?|needed|pending|planned|plans?|going\s+to|about\s+to|ready|wait|waiting|waits|ensure|make\s+sure|check|verify|confirm|expect|expected|assume|assuming|hope|be|get|gets|getting|said|says|claimed|claims|reported|told|supposedly|allegedly|later|soon|tomorrow|otherwise)\b|n[’']t\b/i;

const SKIPPED_PARTS = heading("DONE WHEN|OUT OF SCOPE");
const OTHER_PARTS = heading("GOAL|DO|DECIDED|RULES");

const PR_ITEM = String.raw`(?:https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+|#\d+)(?![\w/])`;
const PR_LIST = String.raw`${PR_ITEM}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)${PR_ITEM})*`;
const PR_NOUN = String.raw`(?:(?:PRs?|pull\s+requests?)\s+)?`;
// The verb's state, required except at the start of a sentence ("- #12 merged").
const BE = String.raw`\s+(?:is|was|are|were|has\s+been|have\s+been|got)(?:\s+(?:now|already|also|both|all))?`;
const LEAD = String.raw`^\s*(?:[-*+]\s+|\d+[.)]\s+)?`;
const NAME = String.raw`(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*`;
const VERSION = String.raw`v?\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?![0-9A-Za-z]|\.\d)`;
// [name][@ or space]version: groups name, separator, version.
const VITEM = String.raw`(?:(?<![\w@./-])(${NAME})(@|\s+))?(?<![\w.-])(${VERSION})`;

const MERGED: RegExp[] = [
  new RegExp(`(${PR_LIST})${BE}\\s+merged\\b`, "gi"),
  new RegExp(`${LEAD}${PR_NOUN}(${PR_LIST})(?:\\s+(?:now|already|both|all))?\\s+merged\\b`, "gi"),
  new RegExp(`\\bmerged\\s+${PR_NOUN}(${PR_LIST})`, "gi"),
];
const TAGGED: RegExp[] = [
  new RegExp(`${VITEM}${BE}\\s+tagged\\b`, "gi"),
  new RegExp(`${LEAD}${VITEM}\\s+tagged\\b`, "gi"),
  new RegExp(`\\btagged\\s+(?:as\\s+)?${VITEM}`, "gi"),
];
const PUBLISHED: RegExp[] = [
  new RegExp(`${VITEM}${BE}\\s+(?:published|(?:(?:live|out|available)\\s+)?on\\s+npm)\\b`, "gi"),
  new RegExp(`${LEAD}${VITEM}\\s+published\\b`, "gi"),
  new RegExp(`\\bpublished\\s+${VITEM}`, "gi"),
];

// Words that stand before a version without naming a package ("published version 0.3.0").
const NOT_NAMES = new Set(["a", "an", "and", "as", "build", "it", "npm", "or", "package", "release", "tag", "the", "then", "version", "now", "is", "was"]);
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

// The claim as written, for the messages, without a list marker.
const said = (match: string) => match.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();

function named(raw: string | undefined): string | null {
  return raw && !NOT_NAMES.has(raw.toLowerCase()) && !/^v?\d/.test(raw) ? raw : null;
}

/** The sentences of a line, each with whether it ends as a question. A dot inside a version
 *  or a URL does not end a sentence; one followed by a space or the line's end does. */
function sentences(line: string): Array<{ text: string; question: boolean }> {
  return (line.match(/(?:[^.!?;:]|[.!?;:](?!\s|$))+[.!?;:]?/g) ?? []).map((text) => ({ text, question: text.trim().endsWith("?") }));
}

/** Every checkable claim `body` states as done, in order, each once. Pure. */
export function factClaims(body: string): FactClaim[] {
  const claims: FactClaim[] = [];
  const seen = new Set<string>();
  const add = (key: string, claim: FactClaim) => {
    if (seen.has(key)) return;
    seen.add(key);
    claims.push(claim);
  };
  let skipping = false;
  proseOnly(body)
    .split("\n")
    .forEach((raw, index) => {
      if (SKIPPED_PARTS.test(raw)) skipping = true;
      else if (OTHER_PARTS.test(raw)) skipping = false;
      if (skipping || /^\s*>/.test(raw)) return;
      const line = raw.replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
      for (const { text, question } of sentences(line)) {
        if (question || NOT_DONE.test(text)) continue;
        const npm = /\bnpm\b/i.test(text);
        for (const pattern of MERGED) {
          for (const m of text.matchAll(pattern)) {
            for (const item of m[1].match(new RegExp(PR_ITEM, "g")) ?? []) {
              const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(item);
              const repo = url ? url[1] : null;
              const number = Number(url ? url[2] : item.slice(1));
              add(`merged:${repo ?? ""}#${number}`, { kind: "merged", line: index + 1, said: said(m[0]), repo, number });
            }
          }
        }
        for (const pattern of TAGGED) {
          for (const m of text.matchAll(pattern)) {
            const name = named(m[1]);
            add(`tagged:${name ?? ""}@${m[3]}`, { kind: "tagged", line: index + 1, said: said(m[0]), name, version: m[3] });
          }
        }
        for (const pattern of PUBLISHED) {
          for (const m of text.matchAll(pattern)) {
            const name = named(m[1]);
            const at = name !== null && m[2] === "@";
            add(`published:${name ?? ""}@${m[3]}`, { kind: "published", line: index + 1, said: said(m[0]), name, at, npm: npm || at, version: m[3] });
          }
        }
      }
    });
  return claims;
}

// ---- Checking ------------------------------------------------------------------------------

type FactRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** What the check reads, injected so the tests need no network. */
export interface FactReaders {
  /** The repos the job's namespace maps, as owner/name. */
  repos(): Promise<FactRead<string[]>>;
  /** The npm packages configured in the Portal (ops_packages), with their repos. */
  packages(): Promise<FactRead<Array<{ name: string; repo: string | null }>>>;
  /** A pull request's state, or null when GitHub has none by that number. */
  pull(repo: string, number: number): Promise<FactRead<{ merged: boolean; state: string } | null>>;
  /** Whether the repo has the tag. */
  tag(repo: string, tag: string): Promise<FactRead<boolean>>;
  /** Every version npm lists for the package, or null when npm has no such package. */
  npm(name: string): Promise<FactRead<string[] | null>>;
}

type Verdict = { state: "true" } | { state: "false"; read: string } | { state: "unchecked"; reason: string } | { state: "skip" };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bare = (version: string) => version.replace(/^v/, "");

export interface FactCheck {
  refusal: string | null;
  warnings: string[];
}

/** Check each claim `body` states against what `readers` read. Refuses only a claim read as
 *  false; a claim that could not be read is a warning. */
export async function checkBodyFacts(namespace: string, body: string, readers: FactReaders): Promise<FactCheck> {
  const claims = factClaims(body);
  if (claims.length === 0) return { refusal: null, warnings: [] };
  let reads = 0;
  const budget = () => reads < MAX_READS;
  let repos: Promise<FactRead<string[]>> | null = null;
  let packages: Promise<FactRead<Array<{ name: string; repo: string | null }>>> | null = null;
  const npmDocs = new Map<string, Promise<FactRead<string[] | null>>>();
  const mapped = () => (repos ??= readers.repos());
  const configured = () => (packages ??= readers.packages());

  async function merged(claim: Extract<FactClaim, { kind: "merged" }>): Promise<Verdict> {
    const list = await mapped();
    if (!list.ok) return { state: "unchecked", reason: list.reason };
    let repo: string | undefined;
    if (claim.repo) {
      repo = list.value.find((r) => same(r, claim.repo!));
      if (!repo) return { state: "unchecked", reason: `${claim.repo} is not a repo ${namespace} maps, so Capsid does not read it` };
    } else if (list.value.length === 1) {
      repo = list.value[0];
    } else {
      return { state: "unchecked", reason: `${namespace} maps ${list.value.length} repos, so #${claim.number} names none of them for certain; write the pull request's URL` };
    }
    if (!budget()) return { state: "unchecked", reason: `the limit of ${MAX_READS} reads for one body was reached` };
    reads++;
    const pr = await readers.pull(repo, claim.number);
    if (!pr.ok) return { state: "unchecked", reason: pr.reason };
    if (pr.value === null) return { state: "unchecked", reason: `GitHub has no pull request ${repo}#${claim.number}` };
    if (pr.value.merged) return { state: "true" };
    return { state: "false", read: `GitHub shows ${repo}#${claim.number} ${pr.value.state === "open" ? "open, not merged" : "closed without merging"}` };
  }

  async function tagged(claim: Extract<FactClaim, { kind: "tagged" }>): Promise<Verdict> {
    const list = await mapped();
    if (!list.ok) return { state: "unchecked", reason: list.reason };
    if (list.value.length === 0) return { state: "unchecked", reason: `${namespace} maps no repo` };
    const v = bare(claim.version);
    const lower = claim.name?.toLowerCase();
    const candidates = [...new Set([`v${v}`, v, ...(lower ? [`${lower}@${v}`, `${lower}-v${v}`] : [])])];
    let unread: string | null = null;
    for (const repo of list.value) {
      for (const tag of candidates) {
        if (!budget()) return { state: "unchecked", reason: `the limit of ${MAX_READS} reads for one body was reached` };
        reads++;
        const got = await readers.tag(repo, tag);
        if (!got.ok) unread ??= got.reason;
        else if (got.value) return { state: "true" };
      }
    }
    if (unread) return { state: "unchecked", reason: unread };
    return { state: "false", read: `no tag ${candidates.join(", ")} exists in ${list.value.join(", ")}` };
  }

  async function packageName(claim: Extract<FactClaim, { kind: "published" }>): Promise<FactRead<string> | null> {
    if (claim.at && claim.name && NPM_NAME.test(claim.name)) return { ok: true, value: claim.name };
    const pkgs = await configured();
    if (!pkgs.ok) return claim.npm ? { ok: false, reason: pkgs.reason } : null;
    let matches: Array<{ name: string; repo: string | null }>;
    if (claim.name) {
      const name = claim.name;
      matches = pkgs.value.filter((p) => same(p.name, name) || same(p.name.replace(/^@[^/]+\//, ""), name));
      if (matches.length === 0) return claim.npm ? { ok: false, reason: `no package configured in the Portal is named ${name}, and the name is not written as name@version` } : null;
    } else {
      const list = await mapped();
      if (!list.ok) return claim.npm ? { ok: false, reason: list.reason } : null;
      matches = pkgs.value.filter((p) => p.repo !== null && list.value.some((r) => same(r, p.repo!)));
      if (matches.length !== 1) {
        return claim.npm ? { ok: false, reason: `the claim names no package and ${namespace} has ${matches.length} configured; write it as name@${bare(claim.version)}` } : null;
      }
    }
    if (matches.length > 1) return { ok: false, reason: `${claim.name} could be any of ${matches.map((p) => p.name).join(", ")}` };
    return { ok: true, value: matches[0].name };
  }

  async function published(claim: Extract<FactClaim, { kind: "published" }>): Promise<Verdict> {
    const name = await packageName(claim);
    // Not said to be on npm and naming no npm package Capsid knows: a GitHub release or
    // another registry, which this check does not read.
    if (name === null) return { state: "skip" };
    if (!name.ok) return { state: "unchecked", reason: name.reason };
    let doc = npmDocs.get(name.value);
    if (!doc) {
      if (!budget()) return { state: "unchecked", reason: `the limit of ${MAX_READS} reads for one body was reached` };
      reads++;
      doc = readers.npm(name.value);
      npmDocs.set(name.value, doc);
    }
    const versions = await doc;
    if (!versions.ok) return { state: "unchecked", reason: versions.reason };
    if (versions.value === null) return { state: "false", read: `npm has no package ${name.value}` };
    const v = bare(claim.version);
    if (versions.value.includes(v)) return { state: "true" };
    const last = versions.value.slice(-3).join(", ");
    return { state: "false", read: `npm lists no version ${v} of ${name.value}${last ? ` (the last it lists: ${last})` : ""}` };
  }

  const falses: string[] = [];
  const warnings: string[] = [];
  for (const claim of claims.slice(0, MAX_CLAIMS)) {
    let verdict: Verdict;
    try {
      verdict = claim.kind === "merged" ? await merged(claim) : claim.kind === "tagged" ? await tagged(claim) : await published(claim);
    } catch (err) {
      verdict = { state: "unchecked", reason: err instanceof Error ? err.message : String(err) };
    }
    const where = `line ${claim.line}, "${claim.said}"`;
    if (verdict.state === "false") falses.push(`${where}: ${verdict.read}`);
    else if (verdict.state === "unchecked") warnings.push(`Capsid could not check ${where}: ${verdict.reason}. Not refused; check it before a session relies on it.`);
  }
  if (claims.length > MAX_CLAIMS) {
    warnings.push(`the body states ${claims.length} merged, tagged or published claims; the first ${MAX_CLAIMS} were checked and the rest were not.`);
  }
  if (falses.length === 0) return { refusal: null, warnings };
  return {
    refusal: `the body states as done what Capsid read as not so: ${falses.join("; ")}. A session would build on it. If it has not happened yet, say so ("once #12 is merged", "0.3.0 is not published yet"); if you are quoting it, put it in a code block or an external fence. Nothing was written.`,
    warnings,
  };
}

// ---- The live readers ----------------------------------------------------------------------

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/** The readers post and edit use: the namespace's mapping in D1, the Portal's package rows,
 *  GitHub through the App, and npm's registry. */
function liveFactReaders(env: Env, namespace: string, fetchImpl: FetchLike = (url, init) => fetch(url, init)): FactReaders {
  const gh = async (repo: string, path: string): Promise<Response> => {
    const [owner, name] = repo.split("/");
    return ghFetch(env, owner, name, `/repos/${owner}/${name}${path}`);
  };
  return {
    async repos() {
      try {
        const row = await env.DB.prepare("SELECT repos FROM namespaces WHERE namespace = ?1").bind(namespace).first<{ repos: string | null }>();
        if (!row) return { ok: false, reason: `${namespace} is not a registered namespace` };
        const list: unknown = JSON.parse(row.repos || "[]");
        if (!Array.isArray(list)) return { ok: false, reason: `${namespace}'s repos mapping is not a list` };
        return { ok: true, value: list.map((r: { repo?: unknown }) => r.repo).filter((r): r is string => typeof r === "string" && r.includes("/")) };
      } catch (err) {
        return { ok: false, reason: `${namespace}'s repos mapping could not be read: ${reason(err)}` };
      }
    },
    async packages() {
      try {
        return { ok: true, value: (await readPackageConfig(env.DB)).map((p) => ({ name: p.name, repo: p.repo })) };
      } catch (err) {
        return { ok: false, reason: `the Portal's package rows could not be read: ${reason(err)}` };
      }
    },
    async pull(repo, number) {
      try {
        const res = await gh(repo, `/pulls/${number}`);
        if (res.status === 404) return { ok: true, value: null };
        if (!res.ok) return { ok: false, reason: `GitHub answered ${res.status} for ${repo}#${number}` };
        const pr = (await res.json()) as { merged?: unknown; merged_at?: unknown; state?: unknown };
        return { ok: true, value: { merged: pr.merged === true || typeof pr.merged_at === "string", state: typeof pr.state === "string" ? pr.state : "unknown" } };
      } catch (err) {
        return { ok: false, reason: `GitHub could not be read: ${reason(err)}` };
      }
    },
    async tag(repo, tag) {
      try {
        // The singular ref endpoint matches exactly: 404 for a tag that does not exist.
        const res = await gh(repo, `/git/ref/tags/${encodePath(tag)}`);
        await res.body?.cancel();
        if (res.status === 404) return { ok: true, value: false };
        if (!res.ok) return { ok: false, reason: `GitHub answered ${res.status} for tag ${tag} in ${repo}` };
        return { ok: true, value: true };
      } catch (err) {
        return { ok: false, reason: `GitHub could not be read: ${reason(err)}` };
      }
    },
    async npm(name) {
      try {
        return { ok: true, value: await npmVersions(fetchImpl, name) };
      } catch (err) {
        return { ok: false, reason: reason(err) };
      }
    },
  };
}

/** The check post and edit run, on the live readers. */
export function factCheckBody(env: Env, namespace: string, body: string): Promise<FactCheck> {
  return checkBodyFacts(namespace, body, liveFactReaders(env, namespace));
}
