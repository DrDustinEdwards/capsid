import { gatherInbox } from "./inbox";
import type { Env } from "./env";
import { agentSummaries, type AgentSummary } from "./status";
import { APP_ROSTER } from "./roster";
import { readSiteConfig } from "./ops-sites";
import { readPackageConfig } from "./ops-package-config";
import type { OpsAgent, OpsLive } from "./ops-types/feed";
import { openFindings } from "./watcher-digest";

// The feed's live reads, each shaped for OpsLive (src/ops-feed.ts gathers them).

// An instant as ISO. Columns written by datetime('now') read "YYYY-MM-DD HH:MM:SS", which is UTC
// but which a browser's Date.parse reads as local time, so the feed hands every timestamp over in
// one unambiguous form. Anything else passes through.
export function isoTime(value: string): string;
export function isoTime(value: string | null): string | null;
export function isoTime(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

// One credential as the feed shows it: the inventory capsid_read_status action status serves.
// Grants are left out; the contract carries flags only.
export function opsAgentFrom(agent: AgentSummary): OpsAgent {
  return {
    name: agent.name,
    kind: agent.kind,
    namespaces: agent.namespaces,
    flags: agent.flags,
    last_seen: isoTime(agent.last_seen),
    revoked_at: isoTime(agent.revoked_at),
    pending: agent.pending,
    archived_at: isoTime(agent.archived_at),
  };
}

// The store's size against D1's cap.
export const D1_CAP_BYTES = 10 * 1024 ** 3;

/** The size a D1 result reports, or null when its meta has no number for it. */
export function sizeFrom(meta: unknown): number | null {
  const size = (meta as { size_after?: unknown } | null | undefined)?.size_after;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

// The store's size, from the meta of one small read.
async function storeSize(db: D1Database): Promise<number | null> {
  const { meta } = await db.prepare("SELECT COUNT(*) AS n FROM namespaces").all();
  return sizeFrom(meta);
}

export async function opsLive(env: Env, now: Date): Promise<OpsLive> {
  const [sizeBytes, agents, sites, packages, inbox, findings] = await Promise.all([
    storeSize(env.DB),
    agentSummaries(env.DB),
    readSiteConfig(env.DB),
    readPackageConfig(env.DB),
    gatherInbox(env, now, null),
    openFindings(env.DB),
  ]);
  return {
    generated: now.toISOString(),
    agents: agents.map(opsAgentFrom),
    namespaces: APP_ROSTER.map((name) => ({ name })),
    sites,
    packages,
    store: { size_bytes: sizeBytes, cap_bytes: D1_CAP_BYTES },
    inbox,
    findings,
  };
}
