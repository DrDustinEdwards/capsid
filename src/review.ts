import { kvCached } from "@dustinedwards/site-runtime/kv-cache";
import { githubJson } from "@dustinedwards/site-runtime/github";
import { remoteKeys, verifyJwt, type KeySource } from "@dustinedwards/site-runtime/access-login";
import { untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import type { Env } from "./env";
import {
  MAX_FINDINGS,
  REPORT_TOOL,
  parseVerdict,
  ranOut,
  toolArguments,
  type Finding,
  type Verdict,
} from "./review-answer";
import { ghFetch } from "./github/client";
import { bearerToken } from "@dustinedwards/site-runtime/agent-keys";
import { textResponse } from "@dustinedwards/site-runtime/http";
import { auditStatement } from "./store-guards";

const ISSUER = "https://token.actions.githubusercontent.com";

// The key set's address comes from the issuer's discovery document, as OIDC defines,
// and must be on the issuer's own host.
let keys: KeySource | null = null;
async function issuerKeys(): Promise<KeySource> {
  if (keys) return keys;
  const resp = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!resp.ok) throw new Error(`the issuer's discovery document answered ${resp.status}`);
  const uri = new URL(String(((await resp.json()) as { jwks_uri?: unknown }).jwks_uri));
  if (uri.origin !== ISSUER) throw new Error("the issuer's key set is on another host");
  keys = remoteKeys(uri.href);
  return keys;
}

// The automatic PR reviewer: a model reads the diff, the description and CLAUDE.md at the base (so
// a pull request cannot rewrite its own rules) and says whether the change does what it claims.

export const REVIEW_RUN_PATH = "/review/run";
const REVIEW_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const REVIEW_GATEWAY = "default";
const REVIEW_ACTION = "pr-review";
const REVIEW_AUDIENCE = "capsid-review";
// The devkit workflows allowed to ask, at any ref, in any repository Dustin owns.
const REVIEW_WORKFLOWS = [
  "drdustinedwards/devkit/.github/workflows/review.yml@",
  "drdustinedwards/devkit/.github/workflows/pr.yml@",
];
// Dustin's GitHub account id. Owner ids never change; a login can be renamed and reused.
export const REVIEW_OWNER_ID = "204601333";
const RENOVATE = /^renovate(\[bot\])?$/i;
// One verdict per head commit, so a re-run of the same push asks the model nothing.
const CACHE_TTL_S = 14 * 24 * 3600;
// The diff the model reads, at most. About 75,000 tokens, under a cent of input.
const MAX_DIFF_CHARS = 300_000;
const MAX_FILES = 300;
const MAX_CONTEXT_CHARS = 20_000;
// The model's deadline. A reasoning model on a large diff can take minutes; the workflow
// waits up to ten, and a run that runs out is recorded as an error and asked again next push.
const MODEL_TIMEOUT_MS = 6 * 60_000;
// At the default (high) effort the model spent all its tokens second-guessing a small
// change and never answered. Low still reasons, and answers.
const REASONING = "low";

export type ReviewResult =
  | {
      status: "reviewed";
      verdict: Verdict;
      summary: string;
      findings: Finding[];
      model: string;
      head_sha: string;
    }
  | { status: "skipped"; reasons: string[]; head_sha: string }
  | { status: "error"; error: string; head_sha: string };

// Never skipped: money by name (broad on purpose), migrations, CI, scripts, workers, deploy and
// install configuration and secrets files, even when the file is prose or a test.
const MONEY_PATH =
  /(^|\/)(billing|payments?|checkout|invoices?|pricing|subscriptions?|stripe|payouts?|refunds?)(\/|[-_.]|$)/i;
const ALWAYS_REVIEWED =
  /(^|\/)(migrations|scripts|workers|\.github|\.husky|\.aislop)\/|(^|\/)(wrangler\.(jsonc?|toml)(\.example)?|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s|\.npmrc|\.gitmodules|Dockerfile[^/]*|Makefile)$|(^|\/)(\.dev\.vars|\.env($|\.))/i;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i;
const TEST_FILE =
  /(^|\/)(test|tests|test-integration|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DOC_FILE = /\.(md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;

/** Whether a changed path cannot go wrong quietly: prose, pictures, tests, a lockfile or manifest, a Portal stylesheet. */
export function skippable(path: string): boolean {
  if (MONEY_PATH.test(path) || ALWAYS_REVIEWED.test(path)) return false;
  return (
    LOCKFILE.test(path) ||
    /(^|\/)package\.json$/i.test(path) ||
    TEST_FILE.test(path) ||
    /^dashboard\/.*\.css$/i.test(path) ||
    /^docs\//i.test(path) ||
    DOC_FILE.test(path)
  );
}

interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  patch?: string;
}

/** Whether a pull request's files are worth a review, and why. A rename is judged under both names. */
export function reviewScope(files: readonly ChangedFile[]): { review: boolean; reasons: string[] } {
  if (files.length === 0) return { review: false, reasons: ["no changed files were read"] };
  const reviewed = files
    .flatMap((f) => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]))
    .filter((p) => !skippable(p));
  return reviewed.length === 0
    ? { review: false, reasons: ["only documents, images, tests, lockfiles or manifests changed"] }
    : { review: true, reasons: [`${reviewed.length} changed file(s) hold code or configuration`] };
}

export interface ReviewCaller {
  owner: string;
  repo: string;
  pr: number;
}

// Who a verified token's claims admit: devkit's review.yml, on a pull request, in a repository
// Dustin owns. Anything else is refused with the reason.
export function reviewCaller(claims: Record<string, unknown>): ReviewCaller | { refusal: string } {
  const claim = (name: string) =>
    typeof claims[name] === "string" ? (claims[name] as string) : "";
  const [owner, repo] = claim("repository").split("/");
  const pr = /^refs\/pull\/(\d+)\/merge$/.exec(claim("ref"))?.[1];
  if (claim("repository_owner_id") !== REVIEW_OWNER_ID || !owner || !repo)
    return { refusal: "only a repository Dustin owns may ask for a review" };
  const workflow = claim("job_workflow_ref").toLowerCase();
  if (!REVIEW_WORKFLOWS.some((w) => workflow.startsWith(w)))
    return { refusal: "only devkit's review.yml or pr.yml may ask for a review" };
  if (claim("event_name") !== "pull_request" || !pr)
    return { refusal: "a review is asked for on a pull request only" };
  return { owner, repo, pr: Number(pr) };
}

async function caller(request: Request): Promise<ReviewCaller | Response> {
  const token = bearerToken(request.headers.get("Authorization"));
  if (!token) return textResponse("a GitHub Actions OIDC token is required", 401);
  try {
    const verdict = await verifyJwt(token, await issuerKeys(), {
      issuer: ISSUER,
      audience: REVIEW_AUDIENCE,
    });
    if (!verdict.ok) return textResponse("the OIDC token does not verify", 401);
    const who = reviewCaller(verdict.claims);
    return "refusal" in who ? textResponse(who.refusal, 403) : who;
  } catch {
    return textResponse("the OIDC token does not verify", 401);
  }
}

interface Pull {
  title: string;
  body: string;
  head: string;
  base: string;
  author: string;
}

async function ghJson<T>(env: Env, who: ReviewCaller, path: string): Promise<T> {
  return (await githubJson(
    (p) => ghFetch(env, who.owner, who.repo, p),
    `/repos/${who.owner}/${who.repo}${path}`,
  )) as T;
}

async function readPull(env: Env, who: ReviewCaller): Promise<Pull> {
  const p = await ghJson<{
    title?: string;
    body?: string | null;
    head?: { sha?: string };
    base?: { sha?: string };
    user?: { login?: string };
  }>(env, who, `/pulls/${who.pr}`);
  return {
    title: p.title ?? "",
    body: p.body ?? "",
    head: p.head?.sha ?? "",
    base: p.base?.sha ?? "",
    author: p.user?.login ?? "",
  };
}

async function readFiles(env: Env, who: ReviewCaller): Promise<ChangedFile[]> {
  const files: ChangedFile[] = [];
  for (let page = 1; files.length < MAX_FILES; page++) {
    const batch = await ghJson<ChangedFile[]>(
      env,
      who,
      `/pulls/${who.pr}/files?per_page=100&page=${page}`,
    );
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files.slice(0, MAX_FILES);
}

// CLAUDE.md as it stands at the base. Missing is not an error: not every repository has one.
async function readRules(env: Env, who: ReviewCaller, base: string): Promise<string> {
  const resp = await ghFetch(
    env,
    who.owner,
    who.repo,
    `/repos/${who.owner}/${who.repo}/contents/CLAUDE.md?ref=${base}`,
    {
      headers: { Accept: "application/vnd.github.raw+json" },
    },
  );
  return resp.ok ? (await resp.text()).slice(0, MAX_CONTEXT_CHARS) : "";
}

// The diff as the model reads it: each file's patch under its name, lockfiles left out, cut at the
// cap with a line that says so.
function diffText(files: readonly ChangedFile[]): string {
  let out =
    files.length >= MAX_FILES ? `[only the first ${MAX_FILES} changed files were read]\n` : "";
  for (const f of files) {
    if (LOCKFILE.test(f.filename)) {
      out += `--- ${f.filename} (${f.status ?? "modified"}; a lockfile, not shown)\n`;
      continue;
    }
    const section = `--- ${f.filename} (${f.status ?? "modified"}${f.previous_filename ? `, was ${f.previous_filename}` : ""})\n${f.patch ?? "(no text diff: binary or too large)"}\n`;
    if (out.length + section.length > MAX_DIFF_CHARS) {
      out += `[the diff is cut here at ${MAX_DIFF_CHARS} characters; ${files.length} files changed in all]\n`;
      break;
    }
    out += section;
  }
  return out;
}

const SYSTEM = [
  "You review one pull request for a small network of web apps. You did not write it. CI already ran the tests and type checks, so do not repeat what they catch.",
  "Look for what passes and is still wrong:",
  "- misread description: the change does something other than what the description asks.",
  "- skipped requirement: something the description or the repository's rules require is missing.",
  "- weak test: a test that would pass even if the change were wrong, or a behavior change with no test where the rules ask for one.",
  "- bug: code that will misbehave on a real input.",
  "- security: a secret, an injection, a missing check on who may do something, or untrusted input that is trusted.",
  "Report only a problem you can point to in the diff. Do not report style, naming or taste. Never invent a file or a line. When nothing is wrong, say APPROVE with no findings; that is the most common right answer.",
  "Verdict: APPROVE (nothing found), CHANGES (should be fixed before merging), BLOCK (merging it would do harm that is hard to undo: data loss, a leaked secret, a broken deploy).",
  `Answer by calling report_review once, with at most ${MAX_FINDINGS} findings, the most serious first.`,
  UNTRUSTED_DATA_RULE,
].join("\n");

function prompt(pull: Pull, rules: string, diff: string): string {
  return [
    `The pull request's title and description:\n${untrusted("pull-request", `${pull.title}\n\n${pull.body}`.slice(0, MAX_CONTEXT_CHARS))}`,
    rules
      ? `The repository's rules (CLAUDE.md at the base):\n${untrusted("rules", rules)}`
      : "The repository has no CLAUDE.md.",
    `The diff:\n${untrusted("diff", diff)}`,
  ].join("\n\n");
}

async function record(
  env: Env,
  who: ReviewCaller,
  result: ReviewResult,
  extra: Record<string, unknown>,
): Promise<void> {
  const full = `${who.owner}/${who.repo}`;
  await auditStatement(env.DB, "system:reviewer", REVIEW_ACTION, null, `${full}#${who.pr}`, {
    repo: full,
    pr: who.pr,
    ...result,
    ...extra,
  }).run();
}

export const reviewKey = (who: ReviewCaller, head: string): string =>
  `review:${who.owner}/${who.repo}:${who.pr}:${head}`.toLowerCase();

/** An error and a BLOCK are not kept, so a re-run of the same commit asks again. */
export function keepReview(r: ReviewResult): boolean {
  return r.status !== "error" && !(r.status === "reviewed" && r.verdict === "BLOCK");
}

export async function handleReviewRun(request: Request, env: Env): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const full = `${who.owner}/${who.repo}`;
  let pull: Pull;
  try {
    pull = await readPull(env, who);
  } catch (err) {
    return textResponse(`could not read ${full}#${who.pr}: ${errorMessage(err)}`, 502);
  }
  const result = await kvCached(
    env.APP_KV,
    reviewKey(who, pull.head),
    { ttl: CACHE_TTL_S, keep: keepReview },
    () => reviewPull(env, who, pull, full),
  );
  return Response.json(result);
}

async function reviewPull(
  env: Env,
  who: ReviewCaller,
  pull: Pull,
  full: string,
): Promise<ReviewResult> {
  let result: ReviewResult;
  let extra: Record<string, unknown> = {};
  if (RENOVATE.test(pull.author)) {
    result = { status: "skipped", reasons: ["a Renovate pull request"], head_sha: pull.head };
  } else {
    try {
      const files = await readFiles(env, who);
      const scope = reviewScope(files);
      if (!scope.review) {
        result = { status: "skipped", reasons: scope.reasons, head_sha: pull.head };
      } else if (!env.AI) {
        result = { status: "error", error: "this Worker has no AI binding", head_sha: pull.head };
      } else {
        const rules = await readRules(env, who, pull.base);
        const answer = await env.AI.run(
          REVIEW_MODEL,
          {
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: prompt(pull, rules, diffText(files)) },
            ],
            tools: [REPORT_TOOL],
            tool_choice: "required",
            reasoning_effort: REASONING,
            max_tokens: 16_000,
          },
          {
            gateway: { id: REVIEW_GATEWAY, metadata: { app: "capsid-reviewer", repo: full } },
            signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
          },
        );
        const parsed = parseVerdict(toolArguments(answer), new Set(files.map((f) => f.filename)));
        result = parsed
          ? { status: "reviewed", ...parsed, model: REVIEW_MODEL, head_sha: pull.head }
          : {
              status: "error",
              error: ranOut(answer)
                ? "the model ran out of room before it answered"
                : "the model's answer was not a verdict",
              head_sha: pull.head,
            };
        const usage = (answer as { usage?: unknown } | null)?.usage;
        extra = { why: scope.reasons, usage: usage ?? null };
      }
    } catch (err) {
      result = {
        status: "error",
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        head_sha: pull.head,
      };
    }
  }
  await record(env, who, result, extra);
  logEvent("PR_REVIEW", {
    message: `PR_REVIEW ${full}#${who.pr} ${result.status}${result.status === "reviewed" ? ` ${result.verdict}` : ""}`,
  });
  return result;
}
