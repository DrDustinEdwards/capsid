import assert from "node:assert/strict";
import { test } from "node:test";
import { runQueuedCapsidJobs, runSiteJob } from "../src/site-jobs.ts";
import { captureErrors, fakeD1, fakeEnv, fakeKv, fakeR2 } from "./fakes.ts";

const DOCS = [{ namespace: "capsid", path: "core.md", body: "core" }];
const ASK = "capsid:run-now:backup";

function makeEnv(seedKv: Record<string, string> = {}) {
  const r2 = fakeR2();
  const kv = fakeKv({ seed: seedKv });
  const { db } = fakeD1({ documents: DOCS });
  return { env: fakeEnv({ DB: db, MEDIA: r2.bucket, APP_KV: kv.kv }), r2, kv };
}

test("PLANT: run now of Capsid's backup answers at once and dumps nothing in the request", async () => {
  const { env, r2, kv } = makeEnv();
  const run = await runSiteJob(
    env,
    { namespace: "capsid", name: "backup", actor: "access:admin@example.com", via: "chat" },
    new Date(),
  );
  assert.equal(run.ran, true);
  if (!run.ran) return;
  assert.equal(run.ok, true);
  assert.match(run.line, /^capsid backup: started; it runs within five minutes/);
  assert.equal(r2.objects.size, 0, "the click dumped inside its own request");
  assert.equal(kv.store.has("backup:lease"), false, "the click took the lease");
  assert.match(kv.store.get(ASK) ?? "", / access:admin@example\.com$/);
});

test("the next tick runs an asked backup once, under a lease that frees within the cron wall", async () => {
  const { env, r2, kv } = makeEnv({ [ASK]: "2026-11-25T16:00:00.000Z access:admin@example.com" });
  await captureErrors(() => runQueuedCapsidJobs(env));
  assert.ok(
    [...r2.objects.keys()].some((k) => k.startsWith("backups/json/")),
    "no dump was written",
  );
  assert.equal(kv.store.has(ASK), false, "the ask outlived its run");
  const lease = kv.puts.find((p) => p.key === "backup:lease");
  assert.equal(lease?.ttl, 960);
  assert.equal(kv.store.has("backup:lease"), false, "the lease outlived the run");

  const before = r2.objects.size;
  await captureErrors(() => runQueuedCapsidJobs(env));
  assert.equal(r2.objects.size, before, "one ask ran twice");
});

test("an ask made while the lease is held waits for the tick after it frees", async () => {
  const held = "2026-11-25T16:17:15.000Z another-run";
  const { env, r2, kv } = makeEnv({
    [ASK]: "2026-11-25T16:20:00.000Z access:admin@example.com",
    "backup:lease": held,
  });
  await captureErrors(() => runQueuedCapsidJobs(env));
  assert.equal(r2.objects.size, 0);
  assert.equal(kv.store.get("backup:lease"), held);
  assert.ok(kv.store.has(ASK), "the ask was dropped while the lease was held");

  kv.store.delete("backup:lease");
  await captureErrors(() => runQueuedCapsidJobs(env));
  assert.ok(r2.objects.size > 0, "the ask never ran once the lease freed");
  assert.equal(kv.store.has(ASK), false);
});
