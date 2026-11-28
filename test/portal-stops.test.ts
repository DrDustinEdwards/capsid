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

test("PLANT: each stop previews a revoke of one live agent, and a revoked agent has none", () => {
  const f = feed();
  assert.ok(
    f.live.agents.some((a) => a.revoked_at),
    "the sample has a revoked agent",
  );
  const { list, calls } = run(f);
  for (const c of list) c.run();
  const live = f.live.agents
    .filter((a) => !a.revoked_at)
    .map((a) => `confirm revoke_agent ${JSON.stringify({ name: a.name })}`);
  assert.deepEqual(calls, live);
  assert.ok(list.every((c) => c.group === "Stop"));
});
