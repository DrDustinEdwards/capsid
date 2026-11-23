import type { Kind } from "./derive";
import type { OpsAgent, OpsFeed } from "../types";
import { DAY, HOUR } from "./format";
import { parse } from "capsomer/behavior/time";

// The roster is the live credentials only. A revoked agent leaves it at once, and its row
// leaves the live table 7 days later (docs/auth.md); both are the Archive tab's.
export function rosterAgents(agents: readonly OpsAgent[]): OpsAgent[] {
  return agents.filter((a) => !a.revoked_at && !a.archived_at);
}

/** The Archive tab's rows: revoked and still in the live table, oldest revocation first
 *  (the next to move), then archived, newest move first. */
export function archiveAgents(agents: readonly OpsAgent[]): OpsAgent[] {
  const waiting = agents
    .filter((a) => a.revoked_at && !a.archived_at)
    .sort((x, y) => parse(x.revoked_at as string) - parse(y.revoked_at as string));
  const archived = agents
    .filter((a) => a.archived_at)
    .sort((x, y) => parse(y.archived_at as string) - parse(x.archived_at as string));
  return [...waiting, ...archived];
}

export function agentState(a: OpsAgent, now: number): { kind: Kind; label: string } {
  if (a.archived_at) return { kind: "nodata", label: "Archived" };
  if (a.revoked_at) return { kind: "crit", label: "Revoked" };
  if (a.pending) return { kind: "warn", label: "Waiting for activation" };
  if (!a.last_seen) return { kind: "nodata", label: "Never seen" };
  const d = now - parse(a.last_seen);
  if (d < HOUR) return { kind: "ok", label: "Active" };
  if (d < 2 * DAY) return { kind: "queued", label: "Idle" };
  return { kind: "nodata", label: "Silent" };
}

export function nsList(a: OpsAgent): string {
  return a.namespaces === "*" ? "*" : a.namespaces.join(", ");
}

// A namespace's driver is the agent named <ns>-driver.
export function driverOf(feed: OpsFeed, ns: string): OpsAgent | null {
  return feed.live.agents.find((a) => a.name === `${ns}-driver`) ?? null;
}
