import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// The Portal's service worker (dashboard/public/sw.js): a tapped alert opens the url its push
// named only when that url is on the worker's own scope. Any other url, or none, opens the
// Portal itself, so a push can never send the phone to another site.

const SCOPE = "https://portal.example.com/";
const source = readFileSync(join(import.meta.dirname, "..", "dashboard", "public", "sw.js"), "utf8");

async function tap(data: unknown): Promise<string> {
  const handlers: Record<string, (event: unknown) => void> = {};
  const opened: string[] = [];
  const self = {
    registration: { scope: SCOPE },
    clients: { matchAll: async () => [], openWindow: async (u: string) => opened.push(u), claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      handlers[name] = fn;
    },
  };
  vm.runInNewContext(source, { self, URL });
  let done: Promise<unknown> = Promise.resolve();
  handlers.notificationclick({ notification: { data, close: () => {} }, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  assert.equal(opened.length, 1);
  return opened[0];
}

test("an alert's url on the Portal's scope opens as sent", async () => {
  assert.equal(await tap({ url: `${SCOPE}#/attention` }), `${SCOPE}#/attention`);
  assert.equal(await tap({ url: "/#/jobs" }), `${SCOPE}#/jobs`);
});

test("PLANT: a url off the Portal's scope, or none, opens the Portal itself", async () => {
  for (const url of ["https://evil.example.com/", "//evil.example.com/x", "javascript:alert(1)", "https://portal.example.com.evil.example.com/", "http://[", 42]) {
    assert.equal(await tap({ url }), SCOPE, String(url));
  }
  assert.equal(await tap(null), SCOPE);
  assert.equal(await tap({}), SCOPE);
});
