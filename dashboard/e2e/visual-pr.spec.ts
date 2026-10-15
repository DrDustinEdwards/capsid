import { expect, test } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// A pull request labelled visual waits for Dustin's look (src/visual-pr.ts,
// job_0368576da167). Its row in Awaiting the seat links its preview and screenshots, and
// Approve stays beside them. The feed is reshaped in the browser, so the mock is unchanged.

test("a visual pull request shows its title, preview and screenshots beside Approve", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.awaiting_seat[0] = {
      ...feed.live.awaiting_seat[0]!,
      failed: "visual_awaits_look",
      why: "a visual change: Dustin looks at its preview or screenshots before it merges",
      visual: { title: "New header", preview: "https://pr-32.sample.workers.dev/", shots: ["https://example.com/before.png", "https://example.com/after.png"] },
    };
    await route.fulfill({ response: res, json: feed });
  });
  await visit(page, "prs");
  const awaiting = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Awaiting the seat" }) });
  const look = awaiting.locator(".visual-look");
  await expect(look).toContainText("New header");
  await expect(look.getByRole("link", { name: "Open the preview" })).toHaveAttribute("href", "https://pr-32.sample.workers.dev/");
  await expect(look.getByRole("link", { name: /^Screenshot / })).toHaveCount(2);
  await expect(look.getByRole("link", { name: "Screenshot 2" })).toHaveAttribute("target", "_blank");
  await expect(awaiting.getByRole("button", { name: "Approve example-org/sample-c #32", exact: true })).toBeVisible();
});

test("Awaiting the seat says why a pull request was held in words, not a check name", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.awaiting_seat[0] = { ...feed.live.awaiting_seat[0]!, failed: "paths_not_money" };
    await route.fulfill({ response: res, json: feed });
  });
  await visit(page, "prs");
  const awaiting = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Awaiting the seat" }) });
  await expect(awaiting.getByRole("columnheader", { name: "Held because" })).toBeVisible();
  await expect(awaiting).toContainText("it touches payment code");
  await expect(awaiting).not.toContainText("paths_not_money");
});
