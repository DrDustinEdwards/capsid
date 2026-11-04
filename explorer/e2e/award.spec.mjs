// The award checklist of capsid/research/design-system-explorer.md, section 6, measured in a real
// Chromium on desktop and phone: every system reached by keyboard against the model, no layout shift
// while lighting the network or stepping a flow, and the INP proxy under 4x CPU throttling.
// Lighthouse's numbers (LCP, CLS, TBT, weight) are lighthouse.mjs's.
//
// What a browser cannot prove is said where it is skipped: a real phone's frame rate (the release's
// remote DevTools run) and a screen reader (VoiceOver and NVDA by hand).
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const MODEL = JSON.parse(readFileSync(new URL("../fixtures/model.json", import.meta.url), "utf8"));
/** @type {string[]} */
const IDS = MODEL.systems.map((/** @type {{ id: string }} */ s) => s.id).sort();
const FLOW = "sample-round";
const STEPS = MODEL.flows.find((/** @type {{ id: string }} */ f) => f.id === FLOW).steps.length;

/** Section 6: CLS under 0.05. */
const CLS_BUDGET = 0.05;
/**
 * Section 6: the INP proxy, 100 ms. The page's own share (input delay and handlers) fails over it.
 * The whole duration adds the next paint, which a headless runner with no GPU paints in software,
 * so it is reported, warn only, as dustinedwards-info's /systems check does.
 */
const INPUT_BUDGET_MS = 100;

// The network opens on the hexagons, and a phone on the plain map (Capsomer's system map): a system is the one shown.
const HEX = ".cap-system-map-hex:not([hidden])";
const PLAIN = ".cap-system-map-network:not([hidden])";
const system = (/** @type {string} */ id) => `${HEX} a.cap-system-map-cell[data-id="${id}"], ${PLAIN} .cap-system-map-card[data-id="${id}"]`;
const LINKS = `${HEX} a.cap-system-map-cell, ${PLAIN} .cap-system-map-card-name a`;

/** @param {import("@playwright/test").Page} page @param {string} [path] */
async function open(page, path = "/systems/") {
  await page.route("https://mcp.dustinedwards.info/**", (route) => route.abort());
  await page.goto(path);
  await expect(page.locator(".cap-system-map")).toHaveAttribute("data-cap-ready", "");
}

/** 4x CPU throttling for the body of `run`, through the DevTools protocol. @param {import("@playwright/test").Page} page @param {() => Promise<void>} run */
async function throttled(page, run) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    await run();
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
  }
}

/** A warning a run should show without failing: in the log and on the test's report. @param {string} text */
function warn(text) {
  console.log(`WARN ${text}`);
  test.info().annotations.push({ type: "warning", description: text });
}

test("keyboard: every system in the model, and no other, is a hexagon and a card whose link Tab reaches, with script and without", async ({ page, browser }) => {
  const linked = async (/** @type {import("@playwright/test").Page} */ p) => {
    const cards = await p.$$eval(".cap-system-map-card[data-id]", (els) => els.filter((e) => e.querySelector(".cap-system-map-card-name a[href]")).map((e) => /** @type {HTMLElement} */ (e).dataset.id ?? "").sort());
    const cells = await p.$$eval("a.cap-system-map-cell[data-id][href]", (els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id ?? "").sort());
    return { cards, cells };
  };
  await open(page);
  expect(await linked(page)).toEqual({ cards: IDS, cells: IDS });
  // Tab walks the shown view's links in turn, each lighting its system.
  await page.locator(LINKS).first().focus();
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < IDS.length; i++) {
    seen.add(await page.locator(".cap-system-map").getAttribute("data-lit") ?? "");
    await page.keyboard.press("Tab");
  }
  expect([...seen].sort()).toEqual(IDS);

  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto("/systems/");
  expect(await linked(plain)).toEqual({ cards: IDS, cells: IDS });
  await context.close();
});

test("layout shift: lighting each system moves nothing, and stepping a flow moves nothing on the page", async ({ page }) => {
  /** The map and the step heading by their place in the document, which must not move by a pixel. */
  const place = (/** @type {string[]} */ selectors) =>
    page.evaluate((sels) => sels.map((s) => Math.round((document.querySelector(s)?.getBoundingClientRect().top ?? NaN) + scrollY)), selectors);
  /** With `strict` every shift counts, input-driven ones included; without, only the ones CLS counts. */
  const observe = (strict = true) =>
    page.evaluate((strict) => {
      const w = /** @type {Window & { __shift?: number }} */ (window);
      w.__shift = 0;
      new PerformanceObserver((list) => {
        for (const e of /** @type {Array<PerformanceEntry & { value: number, hadRecentInput: boolean }>} */ (list.getEntries())) if (strict || !e.hadRecentInput) w.__shift = (w.__shift ?? 0) + e.value;
      }).observe({ type: "layout-shift" });
    }, strict);
  const shift = () => page.evaluate(() => /** @type {Window & { __shift?: number }} */ (window).__shift ?? -1);
  const settle = () => page.waitForTimeout(400);

  await open(page);
  // Pointing at a system is not input to CLS, so every shift it caused would count.
  await observe(false);
  const map = [".cap-system-map", ...IDS.map(system)];
  const before = await place(map);
  for (const id of IDS) await page.hover(system(id));
  await settle();
  const moved = Math.max(...(await place(map)).map((y, i) => Math.abs(y - (before[i] ?? NaN))));
  const lighting = await shift();
  expect(lighting, `layout shift ${lighting}`).toBeGreaterThanOrEqual(0);
  expect(lighting, `layout shift ${lighting}`).toBeLessThan(CLS_BUDGET);
  expect(moved, "a system moved while the network lit").toBe(0);

  await open(page, `/flows/${FLOW}/1/`);
  await observe();
  const flow = [".cap-system-map", "#step-title"];
  const start = await place(flow);
  let drift = 0;
  for (let n = 2; n <= STEPS; n++) {
    await page.keyboard.press(String(n));
    await expect(page.locator("#step-title")).toHaveText(`Step ${n} of ${STEPS}`);
    await settle();
    drift = Math.max(drift, ...(await place(flow)).map((y, i) => Math.abs(y - (start[i] ?? NaN))));
  }
  const stepping = await shift();
  expect(stepping, `layout shift ${stepping}`).toBeGreaterThanOrEqual(0);
  expect(stepping, `layout shift ${stepping}`).toBeLessThan(CLS_BUDGET);
  expect(drift, "the map or the step heading moved while stepping").toBe(0);
});

test("INP proxy: under 4x CPU throttling lighting each system by focus is handled under 100 ms", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = /** @type {Window & { __events?: Array<{ duration: number, work: number }> }} */ (window);
    w.__events = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = /** @type {PerformanceEventTiming & { interactionId?: number }} */ (entry);
        if (e.interactionId) w.__events?.push({ duration: e.duration, work: e.processingEnd - e.startTime });
      }
    }).observe(/** @type {PerformanceObserverInit} */ ({ type: "event", durationThreshold: 16, buffered: true }));
  });
  await throttled(page, async () => {
    // Each key waits for the last one's transition, as a reader's does.
    await page.locator(LINKS).first().focus();
    for (let i = 0; i < IDS.length; i++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
    }
  });
  await page.waitForTimeout(500);
  const events = await page.evaluate(() => /** @type {Window & { __events?: Array<{ duration: number, work: number }> }} */ (window).__events ?? []);
  // Event Timing reports nothing under 16 ms, and under 4x throttling a click paints for longer,
  // so an empty list is an observer that saw nothing, not a fast page.
  expect(events.length, "no interaction was measured").toBeGreaterThan(0);
  const work = Math.max(...events.map((e) => e.work));
  const whole = Math.max(...events.map((e) => e.duration));
  expect(work, `slowest input delay plus handling over ${events.length} interactions`).toBeLessThan(INPUT_BUDGET_MS);
  if (whole >= INPUT_BUDGET_MS) warn(`slowest interaction to its next paint ${Math.round(whole)} ms, over ${INPUT_BUDGET_MS} ms (software paint in a GPU-less runner; a real phone is the release's check)`);
});
