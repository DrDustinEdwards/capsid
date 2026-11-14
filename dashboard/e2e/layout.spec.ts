import { expect, test } from "@playwright/test";
import { SITE_TABS } from "../src/app/ctx.ts";
import { RAIL_PREF } from "../src/lib/prefs.ts";
import { ALL_VIEWS, VIEW_COUNT, expectNoSideways, measure, sideways, visit } from "./views.ts";

// No sideways scrolling from 1024 px up: not the document, not main, and not any
// wrapper inside main. Wide tables reflow into cards instead (Capsomer table, data-reflow).

// The narrowest desktop width, with the menu expanded and collapsed (its stored
// preference, set before the app starts).
for (const rail of ["expanded", "collapsed"] as const) {
  test(`at 1024 px, menu ${rail}, no view scrolls sideways`, async ({ page }) => {
    // One test visits every view, so its time grows with the view count.
    test.setTimeout(10_000 * VIEW_COUNT);
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [RAIL_PREF, rail] as const);
    await page.setViewportSize({ width: 1024, height: 900 });
    const problems: string[] = [];
    for (const v of ALL_VIEWS) {
      await visit(page, v.id);
      problems.push(...sideways(await measure(page), `${v.label} at 1024, menu ${rail}`));
    }
    expect(ALL_VIEWS).toHaveLength(VIEW_COUNT);
    expect(problems).toEqual([]);
  });
}

// A site's own page, every tab, at the narrowest desktop width and on a phone.
test("at 1024 px and at 390 px, no tab of a site's page scrolls sideways", async ({ page }) => {
  test.setTimeout(60_000);
  const problems: string[] = [];
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of SITE_TABS) {
      await page.goto(`sites/sample${tab.id === "overview" ? "" : `?tab=${tab.id}`}`);
      await expect(page.getByRole("heading", { level: 1, name: "Sample A" })).toBeVisible();
      await expect(page.locator("main .loading")).toHaveCount(0);
      const o = await measure(page);
      // On a phone a wide table may scroll inside its wrapper; the document may not.
      problems.push(
        ...sideways(
          width === 1024
            ? o
            : {
                ...o,
                root: o.root && {
                  ...o.root,
                  scroll: Math.min(o.root.scroll, o.root.client),
                },
                scrollers: [],
              },
          `${tab.label} at ${width}`,
        ),
      );
    }
  }
  expect(problems).toEqual([]);
});

// One drawer of each type, opened from the first row that opens one.
const DRAWERS = [
  { type: "job", from: "queue" },
  { type: "agent", from: "agents" },
] as const;

for (const d of DRAWERS) {
  test(`at 1024 px the ${d.type} drawer does not scroll sideways`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await visit(page, d.from);
    // A row that opens a drawer: a table row's data-open, or a Capsomer row's title link.
    await page
      .locator(`main :is([data-open^="${d.type}:"], .cap-row-title a[href*="/${d.type}/"])`)
      .first()
      .click();
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
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  for (const v of ALL_VIEWS) {
    test(`${v.label}: the document is no wider than the screen`, async ({ page }) => {
      await visit(page, v.id);
      const w = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(w.client).toBe(390);
      expect(
        w.scroll,
        `${v.label}: the document is ${w.scroll} px wide at 390`,
      ).toBeLessThanOrEqual(w.client);
    });
  }
});

test("a chart's toolbar shows its inline icons under the Portal's CSP", async ({ page }) => {
  await page.goto("demos/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main .loading")).toHaveCount(0);
  // The charts sit in the Trends section, closed until it is opened.
  await page.getByText("Trends", { exact: false }).first().click();
  const toolbar = page.getByRole("toolbar", { name: "Chart controls" }).first();
  await expect(toolbar).toBeVisible();
  // Enarratio 0.12.2: icons are inline SVG, not CSS masks that a page's img-src blocks.
  const icon = toolbar.locator("svg.enarratio-icon").first();
  await expect(icon).toBeVisible();
});
