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

interface Win {
  url: string;
  focused: number;
  went: string[];
  focus: () => Promise<Win>;
  navigate?: (u: string) => Promise<Win>;
}

function win(url: string, canNavigate = true): Win {
  const w: Win = { url, focused: 0, went: [], focus: async () => (w.focused++, w) };
  if (canNavigate) w.navigate = async (u: string) => (w.went.push(u), (w.url = u), w);
  return w;
}

async function tap(data: unknown, windows: Win[] = []): Promise<string> {
  const handlers: Record<string, (event: unknown) => void> = {};
  const opened: string[] = [];
  const self = {
    registration: { scope: SCOPE },
    clients: { matchAll: async () => windows, openWindow: async (u: string) => opened.push(u), claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      handlers[name] = fn;
    },
  };
  vm.runInNewContext(source, { self, URL });
  let done: Promise<unknown> = Promise.resolve();
  handlers.notificationclick({ notification: { data, close: () => {} }, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  const moved = windows.flatMap((w) => w.went);
  assert.equal(opened.length + moved.length, 1, "a tap opened or moved more than one page");
  return opened[0] ?? moved[0]!;
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

test("an open Portal tab moves to the alert's item and comes forward; no second tab opens", async () => {
  const other = win("https://elsewhere.example.com/");
  const portal = win(`${SCOPE}health`);
  assert.equal(await tap({ url: `${SCOPE}queue/job/job_1` }, [other, portal]), `${SCOPE}queue/job/job_1`);
  assert.deepEqual(other.went, [], "a tab off the Portal's scope was moved");
  assert.equal(portal.focused, 1);
});

test("PLANT: an open Portal tab moves only on the scope; a url off it moves the tab to the Portal", async () => {
  const portal = win(`${SCOPE}prs`);
  assert.equal(await tap({ url: "https://evil.example.com/" }, [portal]), SCOPE);
});

test("a tab that cannot be moved is brought forward as it is", async () => {
  const portal = win(`${SCOPE}prs`, false);
  const handlers: Record<string, (event: unknown) => void> = {};
  const opened: string[] = [];
  const self = {
    registration: { scope: SCOPE },
    clients: { matchAll: async () => [portal], openWindow: async (u: string) => opened.push(u), claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      handlers[name] = fn;
    },
  };
  vm.runInNewContext(source, { self, URL });
  let done: Promise<unknown> = Promise.resolve();
  handlers.notificationclick({ notification: { data: { url: `${SCOPE}prs#auto-merge` }, close: () => {} }, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  assert.equal(portal.focused, 1);
  assert.deepEqual(opened, []);
});
