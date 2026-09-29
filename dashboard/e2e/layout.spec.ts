import { expect, test } from "@playwright/test";
import { ALL_VIEWS, VIEW_COUNT, visit } from "./views.ts";

test("the view registry lists every view", () => {
  expect(ALL_VIEWS).toHaveLength(VIEW_COUNT);
});

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
