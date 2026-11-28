import { findingClass, type FindingClass } from "./watcher-checks";
import type { OpsFinding } from "./ops-types/feed";

// The open findings with their class (src/watcher-checks.ts), read from the watcher's memory.

const HEADLINE = /^Watcher: (.*?)\s*\[[^\]]+\]$/;
const LINES_SHOWN = 3;

interface Row {
  fingerprint: string;
  namespace: string;
  title: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  evidence: string;
}

function lastEvidence(raw: string): string[] {
  try {
    const list: unknown = JSON.parse(raw);
    const last = Array.isArray(list)
      ? (list[list.length - 1] as { lines?: unknown } | undefined)
      : undefined;
    return Array.isArray(last?.lines)
      ? (last.lines as unknown[])
          .filter((l): l is string => typeof l === "string")
          .slice(0, LINES_SHOWN)
      : [];
  } catch {
    return [];
  }
}

export async function openFindings(db: D1Database): Promise<OpsFinding[]> {
  const { results } = await db
    .prepare(
      `SELECT fingerprint, namespace, title, first_seen_at, last_seen_at, seen_count, evidence
       FROM watcher_findings WHERE state = 'open' ORDER BY namespace, first_seen_at`,
    )
    .all<Row>();
  const out: OpsFinding[] = [];
  for (const r of results ?? []) {
    const klass: FindingClass = findingClass(r.fingerprint);
    out.push({
      fingerprint: r.fingerprint,
      namespace: r.namespace,
      class: klass,
      headline: HEADLINE.exec(r.title)?.[1] ?? r.title,
      first_seen: r.first_seen_at,
      last_seen: r.last_seen_at,
      seen_count: r.seen_count,
      evidence: lastEvidence(r.evidence),
    });
  }
  return out;
}

// The email's weekly section: open digest-class findings per site. Empty on any day but Monday UTC,
// and empty when none are open.
export async function weeklyDigestLines(db: D1Database, now: Date): Promise<string[]> {
  if (now.getUTCDay() !== 1) return [];
  const digest = (await openFindings(db)).filter((f) => f.class === "digest");
  if (digest.length === 0) return [];
  const bySite = new Map<string, OpsFinding[]>();
  for (const f of digest) bySite.set(f.namespace, [...(bySite.get(f.namespace) ?? []), f]);
  const lines: string[] = [`Weekly digest (${digest.length} open)`];
  for (const [site, list] of bySite) {
    lines.push(`${site}`);
    for (const f of list) lines.push(`- ${f.headline} (since ${f.first_seen.slice(0, 10)})`);
  }
  return lines;
}
