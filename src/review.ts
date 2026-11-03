import { verifyJwt } from "@dustinedwards/site-runtime/access-login";
import { untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { logEvent } from "@dustinedwards/site-runtime/log";
import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { textResponse } from "./http";
import { readJob } from "./jobs-transition";
import { pathClassOf, type PathClass } from "./merge-class";
import { worthReviewer, type ChangedFile } from "./model-routing";
import { issuerKeys, ISSUER } from "./shadow";
import { splitSignedTask } from "./signed-docs";
import { auditStatement } from "./store-guards";

// THE AUTOMATIC PR REVIEWER (D5; Dustin 2026-11-03, "lets do it"). A reviewer that did not
// build the work reads a pull request and says whether it does what it claims. It catches
// what CI and the claim checks cannot: work that passes and is still wrong (a misread job, a
// skipped requirement, a weak test). An ADVISORY TRIAL of four weeks: it never fails a check
// and never blocks a merge. Each verdict is recorded in the audit log, and after the trial
// the verdicts are compared with what really went wrong (reverts, fix-up PRs, defects Dustin
// flagged). It becomes a required check only if it caught real problems with few false
// alarms; otherwise it is removed.
//
// devkit's shared review.yml calls this from every network repository with its GitHub
// Actions OIDC token, so no key is stored anywhere. Capsid reads the pull request itself
// with its GitHub App, decides whether it is worth a review, asks the model and records the
// verdict. The workflow writes the verdict to the pull request's checks, never a comment
// (comments notify).
//
// GOLDFISH INPUT (Google's Elephant-Goldfish model). The reviewer sees the diff, the
// description, the job the description names (if any) and the repository's CLAUDE.md at the
// BASE, so a pull request cannot rewrite the rules it is judged by. It never sees the session
// that wrote the code.
//
// THE MODEL. DeepSeek V4.1 Flash on Workers AI, through the account's `default` AI Gateway,
// so the gateway's logs, analytics and spend limit apply. Another vendor than the author, so
// it does not share Claude's blind spots. Swapping it is the one line below.
//
//   POST /review/run   reviews the token's pull request at its head, or answers with the
//                      verdict already recorded for that head

export const REVIEW_RUN_PATH = "/review/run";
const REVIEW_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const REVIEW_GATEWAY = "default";
const REVIEW_ACTION = "pr-review";
const REVIEW_AUDIENCE = "capsid-review";
// The one workflow allowed to ask, at any ref of devkit, in any repository Dustin owns.
const REVIEW_WORKFLOW = "drdustinedwards/devkit/.github/workflows/review.yml@";
// Dustin's GitHub account id. Owner ids never change; a login can be renamed and reused.
export const REVIEW_OWNER_ID = "204601333";
const RENOVATE = /^renovate(\[bot\])?$/i;
// A verdict per head commit, so a re-run of the same push asks the model nothing.
const CACHE_TTL_S = 14 * 24 * 3600;
// The diff the model reads, at most. About 75,000 tokens, under a cent of input.
const MAX_DIFF_CHARS = 300_000;
const MAX_FILES = 300;
const MAX_CONTEXT_CHARS = 20_000;
const MAX_FINDINGS = 5;
// The model's deadline. A reasoning model on a large diff can take minutes; the workflow
// waits up to ten, and a run that runs out is recorded as an error and asked again next push.
const MODEL_TIMEOUT_MS = 6 * 60_000;

const VERDICTS = ["APPROVE", "CHANGES", "BLOCK"] as const;
export type Verdict = (typeof VERDICTS)[number];
const FINDING_KINDS = ["misread job", "skipped requirement", "weak test", "bug", "security"] as const;
type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  file: string;
  line: number | null;
  note: string;
}

type ReviewResult =
  | { status: "reviewed"; verdict: Verdict; summary: string; findings: Finding[]; model: string; head_sha: string }
  | { status: "skipped"; reasons: string[]; head_sha: string }
  | { status: "error"; error: string; head_sha: string };

// Path classes nothing in the diff can go wrong in quietly: prose and pictures, tests alone,
// lockfiles and manifests (routine bumps), and the Portal's stylesheets. A pull request made
// only of these is skipped to save the cost; anything else, code or config, is reviewed.
const SKIPPED_CLASSES: ReadonlySet<PathClass> = new Set(["docs", "tests", "deps-other", "dashboard-css"]);

/** Whether a pull request's files are worth a review, and why. */
export function reviewScope(files: readonly ChangedFile[]): { review: boolean; reasons: string[] } {
  if (files.length === 0) return { review: false, reasons: ["no changed files were read"] };
  const paths = files.flatMap((f) => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]));
  const reviewed = paths.filter((p) => !SKIPPED_CLASSES.has(pathClassOf(p)));
  if (reviewed.length === 0) return { review: false, reasons: ["only documents, images, tests, lockfiles or manifests changed"] };
  const worth = worthReviewer(files);
  return { review: true, reasons: worth.level === "worth" ? worth.reasons : [`${reviewed.length} changed file(s) hold code or configuration`] };
}

export interface ReviewCaller {
  owner: string;
  repo: string;
  pr: number;
}

/** Who a verified token's claims admit: devkit's review.yml, on a pull request, in a
 *  repository Dustin owns. Anything else is refused with the reason. */
export function reviewCaller(claims: Record<string, unknown>): ReviewCaller | { refusal: string } {
  const claim = (name: string) => (typeof claims[name] === "string" ? (claims[name] as string) : "");
  const [owner, repo] = claim("repository").split("/");
  const pr = /^refs\/pull\/(\d+)\/merge$/.exec(claim("ref"))?.[1];
  if (claim("repository_owner_id") !== REVIEW_OWNER_ID || !owner || !repo) return { refusal: "only a repository Dustin owns may ask for a review" };
  if (!claim("job_workflow_ref").toLowerCase().startsWith(REVIEW_WORKFLOW)) return { refusal: "only devkit's review.yml may ask for a review" };
  if (claim("event_name") !== "pull_request" || !pr) return { refusal: "a review is asked for on a pull request only" };
  return { owner, repo, pr: Number(pr) };
}

async function caller(request: Request): Promise<ReviewCaller | Response> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) return textResponse("a GitHub Actions OIDC token is required", 401);
  try {
    const verdict = await verifyJwt(token, await issuerKeys(), { issuer: ISSUER, audience: REVIEW_AUDIENCE });
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
  const resp = await ghFetch(env, who.owner, who.repo, `/repos/${who.owner}/${who.repo}${path}`);
  if (!resp.ok) throw new Error(`GitHub answered ${resp.status} for ${path}`);
  return (await resp.json()) as T;
}

async function readPull(env: Env, who: ReviewCaller): Promise<Pull> {
  const p = await ghJson<{ title?: string; body?: string | null; head?: { sha?: string }; base?: { sha?: string }; user?: { login?: string } }>(env, who, `/pulls/${who.pr}`);
  return { title: p.title ?? "", body: p.body ?? "", head: p.head?.sha ?? "", base: p.base?.sha ?? "", author: p.user?.login ?? "" };
}

interface PullFile extends ChangedFile {
  patch?: string;
}

async function readFiles(env: Env, who: ReviewCaller): Promise<PullFile[]> {
  const files: PullFile[] = [];
  for (let page = 1; files.length < MAX_FILES; page++) {
    const batch = await ghJson<PullFile[]>(env, who, `/pulls/${who.pr}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files.slice(0, MAX_FILES);
}

// CLAUDE.md as it stands at the base. Missing is not an error: not every repository has one.
async function readRules(env: Env, who: ReviewCaller, base: string): Promise<string> {
  const resp = await ghFetch(env, who.owner, who.repo, `/repos/${who.owner}/${who.repo}/contents/CLAUDE.md?ref=${base}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  return resp.ok ? (await resp.text()).slice(0, MAX_CONTEXT_CHARS) : "";
}

// The Capsid job the description names, when it is a job of a namespace this repository is
// mapped to. A job of another namespace is not this pull request's to be judged against.
async function readNamedJob(env: Env, who: ReviewCaller, body: string): Promise<{ id: string; text: string } | null> {
  const id = /\bjob_[0-9a-f]{12}\b/.exec(body)?.[0];
  if (!id) return null;
  const job = await readJob(env.DB, id);
  if (!job) return null;
  const row = await env.DB.prepare("SELECT repos FROM namespaces WHERE namespace = ?1").bind(job.namespace).first<{ repos: string }>();
  const full = `${who.owner}/${who.repo}`.toLowerCase();
  let mapped = false;
  try {
    mapped = (JSON.parse(row?.repos ?? "[]") as Array<{ repo?: string }>).some((r) => r.repo?.toLowerCase() === full);
  } catch {
    mapped = false;
  }
  return mapped ? { id, text: `${job.title}\n\n${splitSignedTask(job.body).body}`.slice(0, MAX_CONTEXT_CHARS) } : null;
}

/** The diff as the model reads it: each file's patch under its name, lockfiles left out, cut
 *  at the cap with a line that says so. */
function diffText(files: readonly PullFile[]): string {
  let out = "";
  for (const f of files) {
    if (pathClassOf(f.filename) === "deps-other" && !/package\.json$/i.test(f.filename)) {
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
  "- misread job: the change does something other than what the job or the description asks.",
  "- skipped requirement: something the job, the description or the repository's rules require is missing.",
  "- weak test: a test that would pass even if the change were wrong, or a behavior change with no test where the rules ask for one.",
  "- bug: code that will misbehave on a real input.",
  "- security: a secret, an injection, a missing check on who may do something, or untrusted input that is trusted.",
  "Report only a problem you can point to in the diff. Do not report style, naming or taste. Never invent a file or a line. When nothing is wrong, say APPROVE with no findings; that is the most common right answer.",
  "Verdict: APPROVE (nothing found), CHANGES (should be fixed before merging), BLOCK (merging it would do harm that is hard to undo: data loss, a leaked secret, a broken deploy).",
  `Answer by calling report_review once, with at most ${MAX_FINDINGS} findings, the most serious first.`,
  UNTRUSTED_DATA_RULE,
].join("\n");

function prompt(pull: Pull, rules: string, job: { id: string; text: string } | null, diff: string): string {
  return [
    `The pull request's title and description:\n${untrusted("pull-request", `${pull.title}\n\n${pull.body}`.slice(0, MAX_CONTEXT_CHARS))}`,
    job ? `The job it names, ${job.id}:\n${untrusted("job", job.text)}` : "It names no job.",
    rules ? `The repository's rules (CLAUDE.md at the base):\n${untrusted("rules", rules)}` : "The repository has no CLAUDE.md.",
    `The diff:\n${untrusted("diff", diff)}`,
  ].join("\n\n");
}

// The answer as structured output: one call of this tool, its arguments read whole. DeepSeek
// V4.1 Flash supports function calling on Workers AI; JSON mode does not list it yet.
const REPORT_TOOL = {
  type: "function",
  function: {
    name: "report_review",
    description: "Report the review of this pull request.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: [...VERDICTS] },
        summary: { type: "string", description: "One or two plain sentences." },
        findings: {
          type: "array",
          maxItems: MAX_FINDINGS,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...FINDING_KINDS] },
              file: { type: "string", description: "A path from the diff." },
              line: { type: ["integer", "null"], description: "The line in the new file, or null." },
              note: { type: "string", description: "What is wrong and why, in one or two sentences." },
            },
            required: ["kind", "file", "line", "note"],
          },
        },
      },
      required: ["verdict", "summary", "findings"],
    },
  },
} as const;

/** The arguments of the model's report_review call, in either answer shape Workers AI gives
 *  (its own `tool_calls`, or the OpenAI `choices`), parsed whole. Null when there is none. */
export function toolArguments(answer: unknown): unknown {
  const a = answer as {
    tool_calls?: Array<{ name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } }>;
  } | null;
  const calls = [...(a?.tool_calls ?? []), ...(a?.choices?.[0]?.message?.tool_calls ?? [])];
  const call = calls.find((c) => ((c as { name?: string }).name ?? c.function?.name) === "report_review");
  const args = (call as { arguments?: unknown } | undefined)?.arguments ?? call?.function?.arguments;
  if (typeof args !== "string") return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

/** The model's answer, held to the shape the check shows: a known verdict, at most five
 *  findings of a known kind on a file the pull request changed. Anything else is null. */
export function parseVerdict(args: unknown, changed: ReadonlySet<string>): { verdict: Verdict; summary: string; findings: Finding[] } | null {
  if (!args || typeof args !== "object") return null;
  const raw = args as { verdict?: unknown; summary?: unknown; findings?: unknown };
  const verdict = typeof raw.verdict === "string" ? (raw.verdict.trim().toUpperCase() as Verdict) : null;
  if (!verdict || !VERDICTS.includes(verdict)) return null;
  const findings: Finding[] = [];
  for (const f of Array.isArray(raw.findings) ? (raw.findings as Array<Record<string, unknown>>) : []) {
    const kind = typeof f?.kind === "string" ? (f.kind.trim().toLowerCase() as FindingKind) : null;
    const file = typeof f?.file === "string" ? f.file.trim().replace(/^[ab]\//, "") : "";
    const note = typeof f?.note === "string" ? f.note.trim().slice(0, 600) : "";
    if (!kind || !FINDING_KINDS.includes(kind) || !changed.has(file) || !note) continue;
    const line = typeof f.line === "number" && Number.isInteger(f.line) && f.line > 0 ? f.line : null;
    findings.push({ kind, file, line, note });
    if (findings.length === MAX_FINDINGS) break;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 600) : "";
  return { verdict, summary, findings };
}

async function record(env: Env, who: ReviewCaller, result: ReviewResult, extra: Record<string, unknown>): Promise<void> {
  const full = `${who.owner}/${who.repo}`;
  await auditStatement(env.DB, "system:reviewer", REVIEW_ACTION, null, `${full}#${who.pr}`, { repo: full, pr: who.pr, ...result, ...extra }).run();
}

export async function handleReviewRun(request: Request, env: Env): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const full = `${who.owner}/${who.repo}`;
  let pull: Pull;
  try {
    pull = await readPull(env, who);
  } catch (err) {
    return textResponse(`could not read ${full}#${who.pr}: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  const cacheKey = `review:${full.toLowerCase()}:${who.pr}:${pull.head}`;
  const cached = await env.APP_KV.get(cacheKey, "json");
  if (cached) return Response.json(cached);

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
        const [rules, job] = await Promise.all([readRules(env, who, pull.base), readNamedJob(env, who, pull.body)]);
        const answer = await env.AI.run(
          REVIEW_MODEL,
          { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(pull, rules, job, diffText(files)) }], tools: [REPORT_TOOL], tool_choice: "required", max_tokens: 16_000 },
          { gateway: { id: REVIEW_GATEWAY, metadata: { app: "capsid-reviewer", repo: full } }, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) }
        );
        const parsed = parseVerdict(toolArguments(answer), new Set(files.map((f) => f.filename)));
        result = parsed
          ? { status: "reviewed", ...parsed, model: REVIEW_MODEL, head_sha: pull.head }
          : { status: "error", error: "the model's answer was not a verdict", head_sha: pull.head };
        const usage = (answer as { usage?: unknown } | null)?.usage;
        extra = { job_id: job?.id ?? null, why: scope.reasons, usage: usage ?? null };
      }
    } catch (err) {
      result = { status: "error", error: err instanceof Error ? err.message.slice(0, 300) : String(err), head_sha: pull.head };
    }
  }
  await record(env, who, result, extra);
  // An error is not kept, so the next push or a re-run asks again.
  if (result.status !== "error") await env.APP_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_S });
  logEvent("PR_REVIEW", { message: `PR_REVIEW ${full}#${who.pr} ${result.status}${result.status === "reviewed" ? ` ${result.verdict}` : ""}` });
  return Response.json(result);
}
