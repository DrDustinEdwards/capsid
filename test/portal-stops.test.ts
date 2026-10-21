import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OpsFeed } from "../src/ops-types/feed.ts";

// Every stop in the command menu (dashboard/src/lib/stops.ts; capsid/decisions.md
// 2026-09-30, "admin panels review adopted", item 4), on the dashboard's sample feed.
// Each is listed only while there is something to stop, and each runs the control it
// stands for: a switch in Settings' Automation panel, or the confirm dialog.
const { stopCommands } = await import("../dashboard/src/lib/stops.ts");

const SAMPLE = readFileSync(join(import.meta.dirname, "..", "dashboard", "dev", "sample-feed.json"), "utf8");
const feed = (): OpsFeed => JSON.parse(SAMPLE) as OpsFeed;

function run(f: OpsFeed) {
  const calls: string[] = [];
  const list = stopCommands(f, {
    flip: (id) => void calls.push(`flip ${id}`),
    confirm: (r) => void calls.push(`confirm ${r.action} ${JSON.stringify(r.params)}`),
  });
  return { list, calls, texts: list.map((c) => c.text) };
}

test("PLANT: a revoked agent has no Revoke, and an off switch no Turn off", () => {
  const f = feed();
  f.live.overnight.mode = "off";
  const { texts } = run(f);
  const revoked = f.live.agents.filter((a) => a.revoked_at).map((a) => a.name);
  assert.ok(revoked.length > 0, "the sample has a revoked agent");
  for (const name of revoked) assert.ok(!texts.includes(`Revoke ${name}`), name);
  assert.ok(!texts.includes("Turn the overnight run off"));
});

test("PLANT: each stop runs its own control: a switch is pressed, a revoke previews", () => {
  const f = feed();
  f.live.overnight.mode = "subscription";
  const { list, calls } = run(f);
  for (const c of list) c.run();
  const live = f.live.agents.filter((a) => !a.revoked_at).map((a) => `confirm revoke_agent ${JSON.stringify({ name: a.name })}`);
  assert.deepEqual(calls, ["flip sw-overnight", ...live]);
  assert.ok(list.every((c) => c.group === "Stop"));
});

test("there is no stop-all", () => {
  const f = feed();
  f.live.overnight.mode = "api";
  assert.ok(!run(f).texts.some((t) => /\ball\b/i.test(t)));
});

test("no feed, no stops", () => {
  assert.deepEqual(stopCommands(null, { flip: () => {}, confirm: () => {} }), []);
});
