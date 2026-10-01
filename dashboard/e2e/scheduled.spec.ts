import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The run ledger's panel on Incidents (src/task-runs.ts; job_fe0da37c07e0 PR 1), on the
// sample feed: every scheduled task, its state and its newest run, and the earlier
// runs folded under it.

test("Incidents lists every scheduled task with its state, its last run and what it did", async ({ page }) => {
  await visit(page, "incidents");
  const panel = page.locator("#scheduled");
  await expect(panel.getByRole("heading", { name: "Scheduled tasks" })).toBeVisible();
  await expect(panel.locator("tbody tr")).toHaveCount(9);

  const merge = panel.locator('tr[data-task="auto-merge"]');
  await expect(merge.locator("td").nth(1)).toHaveText("Failing");
  await expect(merge.locator("td").nth(2)).toContainText("Refused");
  await expect(merge.locator("td").nth(3)).toContainText("the policy document does not name required_checks");

  await expect(panel.locator('tr[data-task="skill-cycle"] td').nth(1)).toHaveText("No run yet");
  await expect(panel.locator('tr[data-task="backup"] td').nth(1)).toHaveText("Running");

  const tick = panel.locator('tr[data-task="tick"]');
  await expect(tick.locator("summary")).toHaveText("2 earlier");
  await tick.locator("summary").click();
  await expect(tick.locator("details li")).toHaveCount(2);
});

test("a failing scheduled task is in Needs attention", async ({ page }) => {
  await visit(page, "overview");
  const row = page.locator("main section.attention").getByText("Auto-merge step: its last run refused");
  await expect(row).toBeVisible();
});
