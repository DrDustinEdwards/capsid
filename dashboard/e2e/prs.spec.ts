import { expect, test } from "@playwright/test";
import { expectNoSideways, measure, visit } from "./views.ts";

// Pull requests (the UX audit of 2026-10-19, B2 and m6): what waits for you comes first, on
// a phone each pull request is a card with full-width Approve and Close on the first screen,
// and the chart is last.

test("PLANT: Waiting for you is the first panel, and the merges chart is the last", async ({ page }) => {
  await visit(page, "prs");
  const titles = await page.locator("main .cap-panel > .cap-panel-head h2, main .cap-panel > header h2").allInnerTexts();
  expect(titles[0]).toBe("Waiting for you");
  await expect(page.locator("#merge-trend")).toBeVisible();
  const order = await page.evaluate(() => ["#waiting-prs", "#auto-merge", "#merge-trend"].map((s) => document.querySelector(s)!.getBoundingClientRect().top));
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
});

test("PLANT: on a phone each pull request is a card whose Approve and Close are full width, 44 px tall, on the first screen", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await visit(page, "prs");
  const card = page.locator("#pr-example-org-sample-c-32");
  const approve = card.getByRole("button", { name: "Approve example-org/sample-c #32", exact: true });
  const close = card.getByRole("button", { name: "Close example-org/sample-c #32", exact: true });
  const a = (await approve.boundingBox())!;
  const c = (await close.boundingBox())!;
  const box = (await card.boundingBox())!;
  expect(a.height).toBeGreaterThanOrEqual(44);
  expect(a.x + a.width).toBeLessThanOrEqual(c.x + 1);
  // The two buttons share the card's width between them.
  expect(a.width + c.width).toBeGreaterThan(box.width - 60);
  expect(a.y + a.height).toBeLessThan(915);
  expectNoSideways(await measure(page), "Pull requests at 412");
});
