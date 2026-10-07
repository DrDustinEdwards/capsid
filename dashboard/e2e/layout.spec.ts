import { expect, test } from "@playwright/test";
import { RAIL_PREF } from "../src/lib/prefs.ts";
import { ALL_VIEWS, VIEW_COUNT, expectNoSideways, measure, sideways, visit } from "./views.ts";

// No sideways scrolling from 1024 px up: not the document, not main, and not any
// wrapper inside main. Wide tables reflow into cards instead (styles.css, .reflow).

test("the view registry lists every view", () => {
  expect(ALL_VIEWS).toHaveLength(VIEW_COUNT);
});

const WIDTHS = [1920, 1440, 1280, 1024];

// The menu at its full width (208 px) and collapsed (folded away, 0 px; the 56 px strip stays),
// set through its stored preference before the app starts.
const RAIL = [
  { state: "expanded", width: 208 },
  { state: "collapsed", width: 0 },
] as const;

for (const rail of RAIL) {
  for (const width of WIDTHS) {
    test(`at ${width} px, menu ${rail.state}, no view scrolls sideways`, async ({ page }) => {
      // One test visits every view, so its time grows with the view count.
      test.setTimeout(10_000 * VIEW_COUNT);
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [RAIL_PREF, rail.state] as const);
      await page.setViewportSize({ width, height: 900 });
      let seen = 0;
      const problems: string[] = [];
      for (const v of ALL_VIEWS) {
        await visit(page, v.id);
        expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(width);
        // The menu really is in the state under test.
        expect(await page.locator("nav.cap-admin-menu").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(rail.width);
        expect(await page.locator("nav.cap-admin-strip").evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(56);
        problems.push(...sideways(await measure(page), `${v.label} at ${width}, menu ${rail.state}`));
        seen++;
      }
      expect(seen).toBe(VIEW_COUNT);
      expect(problems).toEqual([]);
    });
  }
}

// One drawer of each type, opened from the first row that opens one.
const DRAWERS = [
  { type: "site", from: "sites" },
  { type: "job", from: "queue" },
  { type: "agent", from: "agents" },
] as const;

for (const d of DRAWERS) {
  test(`at 1024 px the ${d.type} drawer does not scroll sideways`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await visit(page, d.from);
    await page.locator(`main [data-open^="${d.type}:"]`).first().click();
    const drawer = page.locator("dialog.drawer[open]");
    await expect(drawer).toBeVisible();
    // The drawer slides in; measure once it has arrived.
    await expect.poll(() => drawer.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
    expectNoSideways(await measure(page, "dialog.drawer[open]"), `the ${d.type} drawer at 1024`);
    expectNoSideways(await measure(page), `main behind the ${d.type} drawer at 1024`);
  });
}

test.describe("on a phone", () => {
  // A mobile browser widens its layout viewport to fit anything that overflows the
  // document, so at phone width nothing may.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const v of ALL_VIEWS) {
    test(`${v.label}: the document is no wider than the screen`, async ({ page }) => {
      await visit(page, v.id);
      const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.client).toBe(390);
      expect(w.scroll, `${v.label}: the document is ${w.scroll} px wide at 390`).toBeLessThanOrEqual(w.client);
    });
  }
});
