import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { OpsFeed } from "../src/ops-types/feed.ts";

const { stopCommands } = await import("../dashboard/src/lib/stops.ts");

const SAMPLE = readFileSync(
  join(import.meta.dirname, "..", "dashboard", "dev", "sample-feed.json"),
  "utf8",
);
const feed = (): OpsFeed => JSON.parse(SAMPLE) as OpsFeed;

function run(f: OpsFeed) {
  const calls: string[] = [];
  const list = stopCommands(f, {
    confirm: (r) => void calls.push(`confirm ${r.action} ${JSON.stringify(r.params)}`),
  });
  return { list, calls, texts: list.map((c) => c.label) };
}

test("PLANT: a revoked agent has no Revoke", () => {
  const f = feed();
  const { texts } = run(f);
  const revoked = f.live.agents.filter((a) => a.revoked_at).map((a) => a.name);
  assert.ok(revoked.length > 0, "the sample has a revoked agent");
  for (const name of revoked) assert.ok(!texts.includes(`Revoke ${name}`), name);
});

test("PLANT: each stop runs its own control: a revoke previews", () => {
  const f = feed();
  const { list, calls } = run(f);
  for (const c of list) c.run();
  const live = f.live.agents
    .filter((a) => !a.revoked_at)
    .map((a) => `confirm revoke_agent ${JSON.stringify({ name: a.name })}`);
  assert.deepEqual(calls, live);
  assert.ok(list.every((c) => c.group === "Stop"));
});
