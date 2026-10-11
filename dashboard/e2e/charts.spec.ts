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

// The six charts drawn with enarratio/lite (0.3.0): bar, line and area. A lite chart comes
// as one <figure> with its legend, an <svg role="img"> with its text alternative, and a
// "Data table" disclosure of the same numbers.

test("PLANT: chart 2, where waiting goes, sums the waits across namespaces and puts the longest gate first", async ({ page }) => {
  await visit(page, "needs");
  const tile = page.locator('[data-chart="waiting"]');
  await expect(tile.getByRole("img", { name: /39\.4 h in all, 30\.6 h of it at needs_human/ })).toBeVisible();
  // needs_human is 24.4 h in sample and 6.2 h in sample-b, both ended by a human.
  const rows = tile.locator("details.enarratio-data tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("needs_human");
  await expect(rows.first()).toContainText("30.6 h");
  await expect(rows.last()).toContainText("open_pr");
});

test("PLANT: chart 3, the queue, says whether it grew or drained over the 14 days", async ({ page }) => {
  await visit(page, "queue");
  const chart = page.locator('[data-chart="queue"]');
  // The mock posts 3 to 6 jobs a day and ends 4 to 6, so the queue drains.
  await expect(chart).toContainText("so the queue drained by");
  await expect(chart.getByRole("img", { name: /Jobs open at each day's end/ })).toBeVisible();
  await expect(chart.locator("details.enarratio-data tbody tr")).toHaveCount(14);
});

test("PLANT: chart 5, claim against verified, has the four agreements for each agent that was checked", async ({ page }) => {
  await visit(page, "agents");
  await page.getByRole("button", { name: "Claims" }).click();
  const chart = page.locator('[data-chart="agreement"]');
  // sample-f has no check, so three agents.
  await expect(chart.getByRole("img", { name: /for 3 agents: 20 agree, 4 disagree, 9 unclaimed, 2 unchecked/ })).toBeVisible();
  await expect(chart.locator("details.enarratio-data tbody tr")).toHaveCount(3);
  await expect(chart.locator("li[data-enarratio-series]")).toHaveText(["agree", "disagree", "unclaimed", "unchecked"]);
});

test("PLANT: chart 6, weekly cost, is drawn against the cap's weekly share and leaves a week with no cost as a gap", async ({ page }) => {
  await visit(page, "agents");
  const chart = page.locator('[data-chart="cost"]');
  await expect(chart.getByRole("img", { name: /Model spend per week for the last 8 weeks/ })).toBeVisible();
  await expect(chart.getByRole("img", { name: /against a weekly share of the \$50 monthly cap \(\$11\.54\)/ })).toBeVisible();
  await expect(chart).toContainText("Cap $50 a month, about $11.54 a week");
  await expect(chart).toContainText("$18.40 of $50 spent this month");
  // Week 2 of the mock has no costed outcome: an empty cell, not $0.00.
  const rows = chart.locator("details.enarratio-data tbody tr");
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(1).locator("td")).toHaveText("");
});

test("PLANT: chart 7, merges, stacks who acted each week and lists the rollbacks", async ({ page }) => {
  await visit(page, "prs");
  const chart = page.locator('[data-chart="merges"]');
  await expect(chart.getByRole("img", { name: /merged by policy with no human/ })).toBeVisible();
  // The mock: auto 4..11 over 8 weeks = 60, approved 3 x 8 = 24, seat 6..0 = 21 -> 60 of 105.
  await expect(chart).toContainText("57% of the 105 merged in 8 weeks went through on the policy alone");
  await expect(chart.locator("[data-rollbacks]")).toContainText("example-org/sample #12");
  await expect(chart.locator("li[data-enarratio-series]")).toHaveCount(4);
  await expect(chart.locator("details.enarratio-data tbody tr")).toHaveCount(8);
});

test("PLANT: chart 9, the site drawer's error rate, marks each deploy in the window and the 1% alert", async ({ page }) => {
  await visit(page, "health");
  await page.locator("#sites tbody tr[data-open]").first().click();
  const chart = page.locator("dialog.drawer .error-rate");
  // Sample A's mock: 2 deploys inside the 24 hours, a peak hour of 0.56% (under the alert).
  await expect(chart.getByRole("img", { name: /Error rate for Sample A over the last 24 hours: peak 0\.56% in an hour, 0\.19% overall, 2 deploys in the window/ })).toBeVisible();
  await expect(chart.locator("svg text", { hasText: "Alert at 1%" })).toHaveCount(1);
  await expect(chart.locator("svg text", { hasText: /^Deploy / })).toHaveCount(2);
  await expect(chart.locator("[data-deploys]")).toContainText(/Deploys: 45bf45ec at \d{4}-\d\d-\d\d \d\d:\d\dZ \(Deploy 97fe911 from main\); 79ec2afc/);
  await expect(chart.locator("details.enarratio-data tbody tr")).toHaveCount(24);
});
