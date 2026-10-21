import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OpsFeed } from "../src/ops-types/feed.ts";

// The Agents page's two lists (dashboard/src/lib/derive.ts, job_24e460427d6c): the roster
// is live credentials only, and the Archive tab holds every revoked one, the next to move
// first, then the archived, newest move first.
const { archiveAgents, rosterAgents } = await import("../dashboard/src/lib/derive.ts");

const SAMPLE = readFileSync(join(import.meta.dirname, "..", "dashboard", "dev", "sample-feed.json"), "utf8");
const agents = () => (JSON.parse(SAMPLE) as OpsFeed).live.agents;

test("the roster lists no revoked or archived agent, and the archive lists every one of them once", () => {
  const all = agents();
  const roster = rosterAgents(all).map((a) => a.name);
  const archive = archiveAgents(all);
  assert.ok(archive.some((a) => a.archived_at) && archive.some((a) => !a.archived_at), "the sample has an archived agent and one waiting to move");
  assert.ok(roster.length > 0, "the sample has live agents");
  assert.deepEqual(roster, all.filter((a) => !a.revoked_at).map((a) => a.name));
  assert.deepEqual([...roster, ...archive.map((a) => a.name)].sort(), all.map((a) => a.name).sort(), "every agent is on exactly one list");
});

test("the archive puts the waiting first, oldest revocation first, then the archived, newest move first", () => {
  const row = (name: string, revoked_at: string, archived_at: string | null) => ({ ...agents()[0], name, revoked_at, archived_at });
  const order = archiveAgents([
    row("archived-old", "2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z"),
    row("waiting-new", "2026-09-27T00:00:00Z", null),
    row("archived-new", "2026-09-10T00:00:00Z", "2026-09-17T00:00:00Z"),
    row("waiting-old", "2026-09-25T00:00:00Z", null),
  ]).map((a) => a.name);
  assert.deepEqual(order, ["waiting-old", "waiting-new", "archived-new", "archived-old"]);
});
