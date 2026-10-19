import { expect, test } from "@playwright/test";
import { expectNoSideways, measure, visit } from "./views.ts";

// Pull requests (the UX audit of 2026-10-19, B2 and m6): what waits for you comes first, on
// a phone each pull request is a card with full-width Approve and Close on the first screen,
// Auto-merge (the signed policy and the safety meter) is one section after it, and the chart
// is last.

test("PLANT: Waiting for you is the first panel, and the merges chart is the last", async ({ page }) => {
  await visit(page, "prs");
  const titles = await page.locator("main .cap-panel > .cap-panel-head h2, main .cap-panel > header h2").allInnerTexts();
  expect(titles[0]).toBe("Waiting for you");
  await expect(page.locator("#merge-trend")).toBeVisible();
  const order = await page.evaluate(() => ["#waiting-prs", "#auto-merge", "#merge-trend"].map((s) => document.querySelector(s)!.getBoundingClientRect().top));
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
});

test("Auto-merge holds the policy panel, then the meter; Load from repo and sign asks for the version and shows the lines", async ({ page }) => {
  await visit(page, "prs");
  const section = page.locator("main #auto-merge");
  const titles = await section.locator(".cap-panel > .cap-panel-head h2, .cap-panel > header h2").allInnerTexts();
  expect(titles).toEqual(["Auto-merge policy", "Auto-merge, last 7 days"]);
  await section.getByRole("button", { name: "Load from repo and sign" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("heading", { name: "Load the auto-merge policy from the repo and sign it" })).toBeVisible();
  await dialog.getByLabel("Version to sign (required)").fill("8");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.locator("[data-summary]")).toContainText("Write the auto-merge policy from docs/policy/auto-merge.md");
  // The lines that change are what is being signed, so Details starts open.
  await expect(dialog.locator("details.confirm-details")).toHaveAttribute("open", "");
  await expect(dialog).toContainText("+ - version: 8");
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
