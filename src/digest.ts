import type { Env } from "./env";
import { AWAITING_SEAT_KEY, type AwaitingSeat } from "./auto-merge-tick";
import { readOvernightDigest } from "./overnight-plan";
import { PORTAL_HOST } from "./portal-host";
import type { DigestState } from "./ops-types/views";
import { logEvent } from "./log";
import { weeklyDigestLines } from "./watcher-digest";

// THE DAILY EMAIL DIGEST (docs/design/design-merge-pipeline.md section 5; Dustin's DECIDE
// 5 of 2026-10-09: Web Push for the four urgent things, and everything else in a daily
// email). Once a UTC day, after DIGEST_HOUR_UTC, the tick mails one plain-text message to
// ALERT_EMAIL: what waits on Dustin now (pull requests by class, questions, blocked jobs),
// rollbacks, and what finished, blocked and became ready since the last digest. It is
// read from what the queue, the auto-merge tick and the watcher already keep, through the
// same reader as capsid_work_jobs action list view digest, so the mail and the Portal
// cannot disagree. It writes nothing but its own state in KV.
//
// It does nothing until Email Routing is on. Cloudflare's send_email binding can only send
// to a destination address verified in Email Routing, and only from the zone that has
// Email Routing turned on, which is an account setting only Dustin can change. So the
// digest needs all four of: the EMAIL binding, ALERT_EMAIL, ALERT_FROM, and the var
// EMAIL_ROUTING set to "on", which the seat sets after Dustin's steps (docs/portal.md,
// "Daily digest"). Until then each tick returns at once, and the Portal's Settings says
// which is missing (digestState below).

export const DIGEST_LAST_KEY = "digest:last";
// 12:00 UTC is 07:00 in Chicago in summer and 06:00 in winter: before the day starts.
const DIGEST_HOUR_UTC = 12;
const DAY_MS = 86_400_000;
const LIST_MAX = 15;
const PORTAL_URL = `https://${PORTAL_HOST}/`;

interface LastDigest {
  at: string;
  outcome: "sent" | "failed";
  note: string;
}

/** Why the digest cannot send, or null when everything it needs is configured. */
export function digestProblem(env: Env): string | null {
  const missing: string[] = [];
  if (!env.EMAIL) missing.push("the send_email binding EMAIL");
  if (!env.ALERT_EMAIL) missing.push("ALERT_EMAIL");
  if (!env.ALERT_FROM) missing.push("ALERT_FROM");
  if (env.EMAIL_ROUTING !== "on") {
    return `Email Routing is not on: EMAIL_ROUTING is ${env.EMAIL_ROUTING ? `"${env.EMAIL_ROUTING}"` : "unset"}, not "on". Dustin turns Email Routing on for the domain and verifies the address, then the seat sets EMAIL_ROUTING to "on"${missing.length ? ` and sets ${missing.join(", ")}` : ""} (docs/portal.md, "Daily digest").`;
  }
  if (missing.length) return `Email Routing is on, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set, so there is nowhere to send from or to.`;
  return null;
}

async function readLast(env: Env): Promise<LastDigest | null> {
  const raw = await env.APP_KV.get(DIGEST_LAST_KEY).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastDigest;
  } catch {
    return null;
  }
}

/** What the Portal shows: on or off and why, and the last send. */
export async function digestState(env: Env): Promise<DigestState> {
  const problem = digestProblem(env);
  return { on: problem === null, problem, to: problem === null ? (env.ALERT_EMAIL ?? null) : null, hour_utc: DIGEST_HOUR_UTC, last: await readLast(env) };
}

const list = <T>(items: T[], line: (t: T) => string): string[] => [
  ...items.slice(0, LIST_MAX).map((t) => `- ${line(t)}`),
  ...(items.length > LIST_MAX ? [`- and ${items.length - LIST_MAX} more in the Portal`] : []),
];

/** The mail, from the state now. Reads only. */
// The reader behind capsid_work_jobs action list view digest, or a test's stand-in.
type DigestReader = typeof readOvernightDigest;

async function composeDigest(env: Env, now: Date, since: string, read: DigestReader = readOvernightDigest): Promise<{ subject: string; text: string; waiting: number }> {
  const raw = await env.APP_KV.get(AWAITING_SEAT_KEY).catch(() => null);
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  const awaiting = (Array.isArray(parsed) ? (parsed as AwaitingSeat[]) : []).filter((a) => a.class !== "auto" && a.class !== "wait");
  const digest = await read(env, { since }, now);
  const questions = digest.blocked.filter((b) => b.summary.startsWith("QUESTION:"));
  const blocked = digest.blocked.filter((b) => !b.summary.startsWith("QUESTION:"));
  const rolled = await env.DB.prepare(
    `SELECT repo, head_sha, outcome FROM deploy_outcomes WHERE outcome IN ('rolled_back', 'rollback_failed') AND recorded_at >= ?1 ORDER BY recorded_at LIMIT 20`
  )
    .bind(since.replace("T", " ").slice(0, 19))
    .all<{ repo: string; head_sha: string; outcome: string }>();
  const rollbacks = rolled.results ?? [];

  const waiting = awaiting.length + questions.length + blocked.length;
  const day = now.toISOString().slice(0, 10);
  const text: string[] = [`Capsid, ${day}. Since ${since.replace("T", " ").slice(0, 16)} UTC.`, ""];
  const section = (title: string, lines: string[]) => {
    if (lines.length) text.push(title, ...lines, "");
  };
  section(
    `Pull requests waiting on you (${awaiting.length})`,
    list(awaiting, (a) => `${a.repo}#${a.number}, class ${a.class ?? "unclassed"}${a.class === "typed" ? " (money: approve by typing its number)" : ""}${a.visual ? ` (visual: look${a.visual.preview ? ` at ${a.visual.preview}` : ""} and approve in the Portal)` : ""}: https://github.com/${a.repo}/pull/${a.number}`)
  );
  section(`Questions (${questions.length})`, list(questions, (q) => `${q.namespace} ${q.id}: ${q.title}`));
  section(`Blocked (${blocked.length})`, list(blocked, (b) => `${b.namespace} ${b.id}: ${b.title}`));
  section(`Rollbacks (${rollbacks.length})`, list(rollbacks, (r) => `${r.repo} at ${r.head_sha.slice(0, 7)}: ${r.outcome === "rollback_failed" ? "the rollback failed" : "rolled back"}`));
  section(`Pull requests ready (${digest.pull_requests_ready.length})`, list(digest.pull_requests_ready, (p) => `${p.namespace} ${p.job_id}: ${p.url}`));
  section(`Finished (${digest.finished.length}), ${digest.pull_requests_merged} pull request(s) merged`, list(digest.finished, (j) => `${j.namespace} ${j.id}: ${j.title} (${j.result_kind ?? j.status})`));
  // Mondays UTC only: the watcher's hygiene findings, per site (src/watcher-digest.ts).
  // A failed read is a note here, never a failed mail.
  let weekly: string[] = [];
  if (now.getUTCDay() === 1) {
    try {
      weekly = await weeklyDigestLines(env.DB, now);
    } catch (err) {
      logEvent("error", "DIGEST_WEEKLY_UNREAD", { message: `DIGEST_WEEKLY_UNREAD: ${err instanceof Error ? err.message : String(err)}` });
      weekly = ["Weekly digest could not be read."];
    }
  }
  if (weekly.length) text.push(...weekly, "");
  if (waiting === 0 && rollbacks.length === 0 && digest.finished.length === 0 && digest.pull_requests_ready.length === 0) text.push("Nothing waits on you and nothing happened.", "");
  if (digest.truncated.length) text.push(`Some lists were cut: ${digest.truncated.join("; ")}.`, "");
  text.push(`Open the Portal: ${PORTAL_URL}`);
  return { subject: `Capsid digest ${day}: ${waiting === 0 ? "nothing waits on you" : `${waiting} waiting on you`}`, text: text.join("\n"), waiting };
}

export interface DigestReport {
  ran: boolean;
  note: string;
  sent: boolean;
}

/** Once a UTC day after DIGEST_HOUR_UTC, when Email Routing is on: compose and send. */
export async function digestTick(env: Env, now: Date, read: DigestReader = readOvernightDigest): Promise<DigestReport> {
  const problem = digestProblem(env);
  if (problem) return { ran: false, note: problem, sent: false };
  if (now.getUTCHours() < DIGEST_HOUR_UTC) return { ran: false, note: `before ${DIGEST_HOUR_UTC}:00 UTC`, sent: false };
  const last = await readLast(env);
  const today = now.toISOString().slice(0, 10);
  if (last && last.at.slice(0, 10) === today) return { ran: false, note: `already ${last.outcome} ${last.at}`, sent: false };
  // Since the last digest that went out, so a failed day's news is in the next one; a
  // first digest, or one after a long gap, covers the last day only.
  const lastAt = last?.outcome === "sent" ? Date.parse(last.at) : NaN;
  const since = new Date(Number.isFinite(lastAt) && now.getTime() - lastAt < 7 * DAY_MS ? lastAt : now.getTime() - DAY_MS).toISOString();
  const mail = await composeDigest(env, now, since, read);
  let record: LastDigest;
  try {
    await env.EMAIL!.send({ from: env.ALERT_FROM!, to: env.ALERT_EMAIL!, subject: mail.subject, text: mail.text });
    record = { at: now.toISOString(), outcome: "sent", note: mail.subject };
  } catch (err) {
    // Recorded for the day, so a refusal is not retried every five minutes; the Portal
    // shows it, and tomorrow's digest covers today too.
    record = { at: now.toISOString(), outcome: "failed", note: `Cloudflare refused the mail: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
  }
  await env.APP_KV.put(DIGEST_LAST_KEY, JSON.stringify(record));
  return { ran: true, note: record.note, sent: record.outcome === "sent" };
}
