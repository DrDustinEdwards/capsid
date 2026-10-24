// The award checklist of capsid/research/design-system-explorer.md, section 6, measured in a real
// Chromium on desktop and phone: every system reached by keyboard, the list against the model, no
// layout shift while entering and stepping a flow, the INP proxy under 4x CPU throttling, and frame
// gaps (warn only). Lighthouse's numbers (LCP, CLS, TBT, weight) are lighthouse.mjs's.
//
// What a browser cannot prove is said where it is skipped: a real phone's frame rate (the release's
// remote DevTools run) and a screen reader (VoiceOver and NVDA by hand).
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

const MODEL = JSON.parse(readFileSync(new URL("../fixtures/model.json", import.meta.url), "utf8"));
/** @type {string[]} */
const IDS = MODEL.systems.map((/** @type {{ id: string }} */ s) => s.id).sort();
const CORE = MODEL.systems.find((/** @type {{ ring: string }} */ s) => s.ring === "core").id;
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
/** Section 6: p95 frame gap while entering, warn only, since runners vary. */
const FRAME_P95_MS = 20;

const tile = (/** @type {string} */ id) => `.cap-system-map-tile[data-id="${id}"]`;
const focusedId = () => /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.id ?? null;

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

test("keyboard: the arrow keys reach every system in the model from the core, and nothing else", async ({ page }) => {
  await open(page);
  /** @type {Set<string>} */
  const seen = new Set([CORE]);
  const queue = [CORE];
  while (queue.length) {
    const id = /** @type {string} */ (queue.shift());
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      // Playwright's focus() refuses an SVG element, and each tile is one.
      await page.$eval(tile(id), (el) => /** @type {SVGElement} */ (el).focus());
      await page.keyboard.press(key);
      const next = await page.evaluate(focusedId);
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  expect([...seen].sort()).toEqual(IDS);
});

test("screen-reader list: the list holds every system in the model and no other, with script and without", async ({ page, browser }) => {
  const listed = (/** @type {import("@playwright/test").Page} */ p) =>
    p.$$eval(".cap-system-map-list li[data-id]", (els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id ?? "").sort());
  await open(page);
  expect(await listed(page)).toEqual(IDS);

  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  await plain.goto("/systems/");
  expect(await listed(plain)).toEqual(IDS);
  await context.close();
});

test("layout shift: entering the core moves nothing above the map, and stepping a flow moves nothing on the page", async ({ page }) => {
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
  // A circle sizes the stage (Capsomer's system map, as on dustinedwards.info/systems), so on a
  // phone what is below the map moves down on the tap that zooms in; the map itself must not.
  await observe(false);
  const map = [".cap-system-map [data-cap-part='stage']"];
  const before = await place(map);
  let moved = 0;
  for (const id of [CORE]) {
    await page.click(tile(id));
    await settle();
    moved = Math.max(moved, ...(await place(map)).map((y, i) => Math.abs(y - (before[i] ?? NaN))));
  }
  await expect(page.locator(".cap-system-map")).toHaveAttribute("data-entered", "");
  await page.keyboard.press("Escape");
  await settle();
  moved = Math.max(moved, ...(await place(map)).map((y, i) => Math.abs(y - (before[i] ?? NaN))));
  const entering = await shift();
  expect(entering, `layout shift ${entering}`).toBeGreaterThanOrEqual(0);
  expect(entering, `layout shift ${entering}`).toBeLessThan(CLS_BUDGET);
  expect(moved, "the map moved while entering").toBe(0);

  await open(page, `/flows/${FLOW}/1/`);
  await observe();
  const flow = [".cap-system-map [data-cap-part='stage']", "#step-title"];
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

test("INP proxy: under 4x CPU throttling every select, enter and escape is handled under 100 ms", async ({ page }) => {
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
    // Each input waits for the last one's animation, as a reader's does.
    for (const id of IDS) {
      await page.click(tile(id));
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
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

test("frames: entering the core under 4x throttling, p95 frame gap (warn only)", async ({ page }) => {
  await open(page);
  /** @type {number[]} */
  let gaps = [];
  await throttled(page, async () => {
    gaps = await page.evaluate(
      (sel) =>
        new Promise((resolve) => {
          /** @type {number[]} */
          const out = [];
          let last = performance.now();
          const end = last + 800;
          const tick = (/** @type {number} */ now) => {
            out.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
          document.querySelector(sel)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }),
      tile(CORE),
    );
  });
  await expect(page.locator(".cap-system-map")).toHaveAttribute("data-entered", "");
  const sorted = gaps.slice(1).sort((a, b) => a - b);
  expect(sorted.length, "no frame was recorded").toBeGreaterThan(0);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  console.log(`frame gap p95 ${p95.toFixed(1)} ms over ${sorted.length} frames`);
  if (p95 > FRAME_P95_MS) warn(`frame gap p95 ${p95.toFixed(1)} ms entering the core, over ${FRAME_P95_MS} ms (runners vary; a real mid-range phone is the release's check)`);
});
