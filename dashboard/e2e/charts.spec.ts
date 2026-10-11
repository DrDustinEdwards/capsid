import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The five charts drawn with Enarratio's primitives (job_d62abdbfc270 PR 6), on the dev
// mock's sample trends, plan and feed. Each is an <svg role="img"> with its own text
// alternative, and each carries a table of the same numbers.

test("PLANT: chart 1, minutes of Dustin per week, says this week's figure and the change", async ({ page }) => {
  await visit(page, "needs");
  const tile = page.locator('[data-chart="minutes"]');
  await expect(tile).toContainText("34 min this week");
  await expect(tile).toContainText("+4 vs last week");
  await expect(tile).toContainText("An estimate");
  await expect(tile.getByRole("img", { name: /Minutes of Dustin per week/ })).toBeVisible();
  await expect(tile.locator("details.enarratio-data tbody tr")).toHaveCount(8);
});

test("chart 4, Tonight, is a timeline with a lane per planned repo", async ({ page }) => {
  await visit(page, "queue");
  const chart = page.locator("#tonight .tonight-chart");
  await expect(chart.getByRole("img", { name: /Tonight's plan/ })).toBeVisible();
  await expect(chart.locator("details.enarratio-data")).toHaveCount(1);
});

test("chart 8, each site's uptime, is a strip of two-hour windows with a text equivalent", async ({ page }) => {
  await visit(page, "health");
  const strip = page.locator("#sites").getByRole("img", { name: /Uptime over 7 days for/ }).first();
  await expect(strip).toBeVisible();
  await expect(strip.locator("rect")).toHaveCount(84);
});

test("PLANT: chart 10, the backup slots, counts each period's kept runs", async ({ page }) => {
  await visit(page, "health");
  const slots = page.locator("#backup-slots");
  await expect(slots.locator('[data-slots="daily"]')).toContainText("13 of 14 kept");
  await expect(slots.locator('[data-slots="weekly"]')).toContainText("8 of 8 kept");
  await expect(slots.locator('[data-slots="monthly"]')).toContainText("5 of 6 kept");
  await expect(slots.getByRole("img", { name: /Daily backups/ })).toBeVisible();
});

test("PLANT: chart 11 says how long a branch has been red, a branch never run, and a repo not read", async ({ page }) => {
  await visit(page, "health");
  const ci = page.locator("#ci-history");
  await expect(ci.locator('[data-ci="sample-b"]')).toContainText("red for 2 days");
  await expect(ci.locator('[data-ci="sample"]')).toContainText("green");
  await expect(ci.locator('[data-ci="sample-c"]')).toContainText("no run in 14 days");
  await expect(ci).toContainText("sample-d not read");
  await expect(ci.getByRole("img", { name: /sample-b default branch/ })).toBeVisible();
});
