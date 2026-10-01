import { expect, test } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// The D1 store's size against its cap on Backups (capsid/decisions.md 2026-09-30,
// "admin panels review adopted", item 5; job_fe0da37c07e0 PR 5).

test("Backups shows the store's size against the cap", async ({ page }) => {
  await visit(page, "backups");
  await expect(page.locator("[data-store-size]")).toHaveText("48.3 MB of 10 GB (0.47%)");
});

test("PLANT: from half the cap Backups flags it and Needs attention lists it", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.store.size_bytes = feed.live.store.cap_bytes * 0.6;
    await route.fulfill({ response: res, json: feed });
  });
  await visit(page, "backups");
  await expect(page.locator("[data-store-size]")).toContainText("6 GB of 10 GB (60%)");
  await expect(page.locator("[data-store-size]")).toContainText("over half the cap");
  await visit(page, "overview");
  await expect(page.locator("main section.attention").getByText("The D1 store is at 60% of its 10 GB cap")).toBeVisible();
});

test("a size D1 did not report says so, not zero", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.store.size_bytes = null;
    await route.fulfill({ response: res, json: feed });
  });
  await visit(page, "backups");
  await expect(page.locator("[data-store-size]")).toHaveText("Not reported");
});
