// The weekly skills refresh. It fetches each model's prompting guide, and when one
// moved it posts a job: the driver runs the `model-refresh` skill in
// DrDustinEdwards/claude-skills and opens a pull request. Nothing applies without
// the merge. A cron, not a tool (CLAUDE.md, tool surface rule).
//
// It may propose edits to .claude/** where the improve loop may not, because the
// loop scores its own attempts and this scores nothing: it proposes to a separate
// repo as a gated job, and a human merges.

import type { Env } from "./env";
import type { Agent } from "./agents";
import { postJob } from "./jobs";
import { bytesToHex } from "./encoding";
import { noFlags } from "./agents-schema";

const DOCS = "https://platform.claude.com/docs/en";
const OVERVIEW = `${DOCS}/about-claude/models/overview.md`;
const guideUrl = (slug: string) => `${DOCS}/build-with-claude/prompt-engineering/prompting-claude-${slug}.md`;

export const SKILLS_NAMESPACE = "claude-skills";
export const SKILLS_REFRESH_ACTOR = "agent:skills-refresh";
export const SCHEDULE_KEY = "skills:refresh:schedule";
export const guideKey = (slug: string) => `skills:guides:${slug}`;

// Monday. The cron fires daily and this decides whether today is the day, so
// changing the day is a KV edit rather than a redeploy.
export const DEFAULT_DAY_UTC = 1;

// test/skills-refresh.test.ts asserts this matches scripts/model-guides.mjs in the
// claude-skills repo.
const MODEL_ID = /\bclaude-(fable|mythos|opus|sonnet|haiku)-\d[a-z0-9-]*/g;
const DATED_SUFFIX = /-\d{8}$/;

export function discoverModels(overview: string): string[] {
  const ids = new Set<string>();
  for (const m of overview.matchAll(MODEL_ID)) ids.add(m[0]);
  return [...new Set([...ids].map((id) => id.replace(/^claude-/, "").replace(DATED_SUFFIX, "")))].sort();
}

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export interface Schedule {
  enabled: boolean;
  dayUtc: number;
  reason: string | null;
}

// Unset takes the default and runs; a KV error disables. Unlike readMode's
// fail-to-off, because a wrong run here posts one gated job (a duplicate is refused
// while one is open), not branches to five repos.
export async function readSchedule(kv: KVNamespace): Promise<Schedule> {
  let raw: string | null;
  try {
    raw = await kv.get(SCHEDULE_KEY);
  } catch (err) {
    return {
      enabled: false,
      dayUtc: DEFAULT_DAY_UTC,
      reason: `could not read ${SCHEDULE_KEY}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (raw === null) return { enabled: true, dayUtc: DEFAULT_DAY_UTC, reason: `${SCHEDULE_KEY} is unset; using the default` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: false, dayUtc: DEFAULT_DAY_UTC, reason: `${SCHEDULE_KEY} does not hold JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { enabled: false, dayUtc: DEFAULT_DAY_UTC, reason: `${SCHEDULE_KEY} does not hold an object` };
  }
  const value = parsed as { enabled?: unknown; dayUtc?: unknown };
  const enabled = value.enabled === undefined ? true : value.enabled === true;
  const day = value.dayUtc;
  if (day !== undefined && (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)) {
    return { enabled: false, dayUtc: DEFAULT_DAY_UTC, reason: `${SCHEDULE_KEY} holds a dayUtc that is not an integer 0-6` };
  }
  return { enabled, dayUtc: day === undefined ? DEFAULT_DAY_UTC : day, reason: null };
}

async function fetchGuide(url: string): Promise<{ status: number; text: string | null }> {
  const res = await fetch(url, { headers: { "user-agent": "capsid skills-refresh" } });
  if (res.status === 404) return { status: 404, text: null };
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return { status: res.status, text: await res.text() };
}

// A narrowly scoped synthetic caller. It may post a job to one namespace and
// nothing else, so a bug here cannot reach another namespace or a repo.
export function skillsRefreshAgent(): Agent {
  return {
    id: SKILLS_REFRESH_ACTOR,
    name: "skills-refresh",
    kind: "cron",
    actor: SKILLS_REFRESH_ACTOR,
    scopes: {
      namespaces: [SKILLS_NAMESPACE],
      repos: [],
      tools: ["jobs"],
      grants: ["write"],
      // Derived, so a new flag cannot be missed.
      flags: noFlags(),
    },
    admin: false,
    row: null,
  };
}

export interface RefreshOutcome {
  ran: boolean;
  skipped: string | null;
  checked: number;
  changed: string[];
  posted: string[];
  refused: { slug: string; reason: string }[];
}

function jobBody(slug: string, url: string): string {
  return [
    `Run the model-refresh skill against the ${slug} prompting guide.`,
    "",
    `The guide moved since the last check. Fetch it with \`npm run guides\` in`,
    `DrDustinEdwards/claude-skills, read \`guides/${slug}.md\` in full, then follow`,
    "`skills/model-refresh/SKILL.md` exactly.",
    "",
    `Source: ${url}`,
    "",
    "Rewrite ONLY model-facing calibration, and ask the skill's three questions",
    "before every edit. A gate, a shipped-artifact rule, or a ruling is refused,",
    "and the refusals belong in the summary. Every changed line carries its",
    "citation comment.",
    "",
    "Open one pull request and BLOCK with its link. Never merge: the merge is the",
    "human gate and it is the only thing that applies any of this.",
  ].join("\n");
}

export async function runSkillsRefresh(env: Env, now: Date): Promise<RefreshOutcome> {
  const empty: RefreshOutcome = { ran: false, skipped: null, checked: 0, changed: [], posted: [], refused: [] };

  const schedule = await readSchedule(env.APP_KV);
  if (!schedule.enabled) return { ...empty, skipped: schedule.reason ?? "disabled" };
  if (now.getUTCDay() !== schedule.dayUtc) {
    return { ...empty, skipped: `today is UTC day ${now.getUTCDay()}, not ${schedule.dayUtc}` };
  }

  const overview = await fetchGuide(OVERVIEW);
  if (!overview.text) throw new Error(`models overview not found at ${OVERVIEW}`);
  const slugs = discoverModels(overview.text);
  // Fail closed on a shape change. Reporting "nothing changed" against zero
  // parsed models would quietly retire this cron and say nothing.
  if (slugs.length === 0) throw new Error(`discovered 0 models in ${OVERVIEW}; the page shape changed`);

  const changed: string[] = [];
  const posted: string[] = [];
  const refused: { slug: string; reason: string }[] = [];
  const agent = skillsRefreshAgent();

  for (const slug of slugs) {
    const url = guideUrl(slug);
    const guide = await fetchGuide(url);
    const prior = await env.APP_KV.get(guideKey(slug));
    if (guide.status === 404) continue;

    const hash = await sha256Hex(guide.text ?? "");
    if (prior === hash) continue;
    changed.push(slug);

    // The hash is stored only after the job is queued, or a failed post would mark
    // the guide seen and never refresh it.
    const result = await postJob(env, agent, now, {
      namespace: SKILLS_NAMESPACE,
      title: `skills: refresh for ${slug}`,
      body: jobBody(slug, url),
      priority: 3,
      gate_required: true,
    });
    if (result.ok) {
      posted.push(slug);
      await env.APP_KV.put(guideKey(slug), hash);
    } else {
      // A duplicate open job means last week's refresh is unfinished. Record the hash
      // so the next real change is what re-posts.
      const reason = result.refusal ?? "refused";
      refused.push({ slug, reason });
      if (/already has an open job/i.test(reason)) await env.APP_KV.put(guideKey(slug), hash);
    }
  }

  return { ran: true, skipped: null, checked: slugs.length, changed, posted, refused };
}
