import type { Env } from "./env";
import { ghFetch, resolveRepo } from "./github/client";
import { readStoredSecrets, type StoredSecrets } from "./secret-presence";

// DUSTIN'S MANUAL STEPS, DONE ONLY WHEN CAPSID CAN SEE THEM (improvement list item 14).
// A session that needs a person to click something (approve an npm publish, add an Access
// app, set a secret, fill a repo's About box) blocks its job as for any gate
// (src/jobs-holder.ts): the reason carries the click steps, and a line of the form
// "check: <form>" in the reason or the command names the result Capsid looks for. The
// forms (docs/work-queue.md):
//   check: secret NAME on <namespace>     the site's Worker has the secret NAME, from the
//                                         names the watcher stored (src/secret-presence.ts)
//   check: npm <package>@<version>        npm lists that version (registry.npmjs.org)
//   check: access app <name>              Cloudflare Access has an application of that name
//   check: github about <owner/repo> [homepage <url>]
//                                         the repo has a description and a homepage (that
//                                         homepage, when one is named), read through the App
// A check line in any other form is a result Capsid cannot see, so it never counts as seen.
//
// The watcher's pass reads them (src/watcher.ts) and writes the counts per job to one APP_KV
// value, as the merge-resume step does for pull requests (src/stale-jobs.ts): the inbox and
// the stale view read the counts and never call out. A job whose every named step is seen
// after it last changed is settled exactly as a merged pull request settles one: the inbox
// stops showing it as waiting on Dustin, and the stale view lists it as steps-seen so it is
// closed or resumed. Nothing here moves a job. A failed read is "unread", never "seen".

export const STALE_STEPS_KEY = "stale:steps";
const MAX_JOBS = 25;
const MAX_STEPS = 5;

export type ManualStep =
  | { kind: "secret"; name: string; namespace: string; text: string }
  | { kind: "npm"; name: string; version: string; text: string }
  | { kind: "access-app"; name: string; text: string }
  | { kind: "github-about"; repo: string; homepage: string | null; text: string }
  | { kind: "unknown"; text: string };

const CHECK_LINE = /^[ \t]*check:[ \t]*(.+?)[ \t]*$/gim;
const SECRET = /^secret\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\s+([a-z0-9][a-z0-9_-]*)$/i;
const NPM = /^npm\s+((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/;
const ACCESS_APP = /^access\s+app\s+(.+)$/i;
const GITHUB_ABOUT = /^github\s+about\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\s+homepage\s+(https?:\/\/\S+))?$/i;

/** One check line's form, or kind "unknown" for a line Capsid has no read for. */
export function parseStep(text: string): ManualStep {
  let m: RegExpMatchArray | null;
  if ((m = text.match(SECRET))) return { kind: "secret", name: m[1]!, namespace: m[2]!.toLowerCase(), text };
  if ((m = text.match(NPM))) return { kind: "npm", name: m[1]!, version: m[2]!, text };
  if ((m = text.match(GITHUB_ABOUT))) return { kind: "github-about", repo: m[1]!, homepage: m[2] ?? null, text };
  if ((m = text.match(ACCESS_APP))) return { kind: "access-app", name: m[1]!.trim(), text };
  return { kind: "unknown", text };
}

/** The manual steps a blocked job's summary names, one per distinct check line. */
export function stepsNamed(summary: string): ManualStep[] {
  const lines = [...new Set([...summary.matchAll(CHECK_LINE)].map((m) => m[1]!))];
  return lines.map(parseStep);
}

export type StepState = "seen" | "unseen" | "unread";

export interface StaleStepEntry {
  seen: number;
  unseen: number;
  unread: number;
  // ISO time of the read.
  at: string;
}

export type StaleStepCache = Record<string, StaleStepEntry>;

export function tallySteps(states: readonly StepState[], at: string): StaleStepEntry {
  const entry: StaleStepEntry = { seen: 0, unseen: 0, unread: 0, at };
  for (const state of states) entry[state] += 1;
  return entry;
}

/** Every step the job names was seen, and it named at least one. */
export function stepsSeen(entry: StaleStepEntry | undefined): boolean {
  return entry !== undefined && entry.unseen === 0 && entry.unread === 0 && entry.seen > 0;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The stored cache, keeping only entries of the right shape. Never written is empty;
 *  anything unreadable is reported, not thrown. */
export function parseStepCache(text: string | null): { cache: StaleStepCache; problem: string | null } {
  if (text === null) return { cache: {}, problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { cache: {}, problem: `${STALE_STEPS_KEY} is not JSON` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { cache: {}, problem: `${STALE_STEPS_KEY} is not a JSON object` };
  const cache: StaleStepCache = {};
  let dropped = 0;
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    const v = (e ?? {}) as Record<string, unknown>;
    if (isCount(v.seen) && isCount(v.unseen) && isCount(v.unread) && typeof v.at === "string") cache[id] = { seen: v.seen, unseen: v.unseen, unread: v.unread, at: v.at };
    else dropped++;
  }
  return { cache, problem: dropped > 0 ? `${STALE_STEPS_KEY} held ${dropped} entr${dropped === 1 ? "y" : "ies"} of the wrong shape, left out` : null };
}

export async function readStepCache(kv: KVNamespace): Promise<{ cache: StaleStepCache; problem: string | null }> {
  return parseStepCache(await kv.get(STALE_STEPS_KEY));
}

// What the pass can read. Each reader throws on a failed read.
export interface StepReaders {
  secrets(namespace: string): Promise<StoredSecrets | null>;
  // null: npm has no such package.
  npmVersions(name: string): Promise<string[] | null>;
  accessAppNames(): Promise<string[]>;
  githubAbout(namespace: string, repo: string): Promise<{ description: string | null; homepage: string | null }>;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** One step as the readers see it now. A read that throws is unread. A secret read before
 *  the job last changed says nothing about the step, so it is unread too. */
export async function stepState(step: ManualStep, job: { namespace: string; updated_at: string }, readers: StepReaders): Promise<StepState> {
  try {
    switch (step.kind) {
      case "secret": {
        const stored = await readers.secrets(step.namespace);
        if (!stored || stored.state !== "ok" || stored.read_at < job.updated_at) return "unread";
        return stored.rows.some((r) => r.name === step.name && r.set) ? "seen" : "unseen";
      }
      case "npm": {
        const versions = await readers.npmVersions(step.name);
        return versions !== null && versions.includes(step.version) ? "seen" : "unseen";
      }
      case "access-app": {
        const want = step.name.toLowerCase();
        return (await readers.accessAppNames()).some((n) => n.trim().toLowerCase() === want) ? "seen" : "unseen";
      }
      case "github-about": {
        const about = await readers.githubAbout(job.namespace, step.repo);
        if (!about.description?.trim() || !about.homepage?.trim()) return "unseen";
        return step.homepage === null || trimSlash(about.homepage.trim()) === trimSlash(step.homepage) ? "seen" : "unseen";
      }
      case "unknown":
        return "unread";
    }
  } catch {
    return "unread";
  }
}

/** The live readers, each remembered for the pass so a name read twice is fetched once. */
export function liveStepReaders(
  env: Env,
  reads: { npmVersions: (name: string) => Promise<string[] | null>; accessAppNames: () => Promise<string[]> }
): StepReaders {
  const once = <T>(memo: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> => {
    let p = memo.get(key);
    if (!p) memo.set(key, (p = read()));
    return p;
  };
  const secrets = new Map<string, Promise<StoredSecrets | null>>();
  const npm = new Map<string, Promise<string[] | null>>();
  const access = new Map<string, Promise<string[]>>();
  const about = new Map<string, Promise<{ description: string | null; homepage: string | null }>>();
  return {
    secrets: (namespace) => once(secrets, namespace, () => readStoredSecrets(env, namespace)),
    npmVersions: (name) => once(npm, name, () => reads.npmVersions(name)),
    accessAppNames: () => once(access, "", reads.accessAppNames),
    githubAbout: (namespace, selector) =>
      once(about, `${namespace} ${selector}`, async () => {
        // The repo must be one the job's namespace maps, as for the pull requests merge-resume reads.
        const { owner, repo } = await resolveRepo(env, namespace, selector);
        const resp = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}`);
        if (!resp.ok) throw new Error(`GitHub answered ${resp.status} for ${owner}/${repo}`);
        const r = (await resp.json()) as { description?: unknown; homepage?: unknown };
        return { description: typeof r.description === "string" ? r.description : null, homepage: typeof r.homepage === "string" ? r.homepage : null };
      }),
  };
}

export interface ManualStepsReport {
  looked: number;
  seen: string[];
  note: string;
}

/**
 * The watcher's step: read the steps every blocked job names (the oldest MAX_JOBS, up to
 * MAX_STEPS each; a job naming more is left unread) and rewrite STALE_STEPS_KEY whole, so a
 * job no longer blocked or no longer naming a step drops out.
 */
export async function checkManualSteps(env: Pick<Env, "DB" | "APP_KV">, now: Date, readers: StepReaders): Promise<ManualStepsReport> {
  const { results } = await env.DB.prepare(
    "SELECT id, namespace, result_summary, updated_at FROM jobs WHERE status = 'blocked' AND result_summary LIKE '%check:%' ORDER BY updated_at LIMIT ?1"
  )
    .bind(MAX_JOBS)
    .all<{ id: string; namespace: string; result_summary: string | null; updated_at: string }>();
  const at = now.toISOString();
  const cache: StaleStepCache = {};
  const seen: string[] = [];
  for (const job of results ?? []) {
    const steps = stepsNamed(job.result_summary ?? "");
    if (steps.length === 0) continue;
    const states = steps.length > MAX_STEPS ? steps.map((): StepState => "unread") : await Promise.all(steps.map((s) => stepState(s, job, readers)));
    cache[job.id] = tallySteps(states, at);
    if (stepsSeen(cache[job.id])) seen.push(job.id);
  }
  await env.APP_KV.put(STALE_STEPS_KEY, JSON.stringify(cache));
  const looked = Object.keys(cache).length;
  return { looked, seen, note: `read the manual steps of ${looked} blocked job(s), every step seen on ${seen.length}${seen.length ? `: ${seen.join(", ")}` : ""}` };
}
