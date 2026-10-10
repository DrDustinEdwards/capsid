import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// The run ledger's panel on Incidents (src/task-runs.ts; job_fe0da37c07e0 PR 1). The
// sample feed's tasks are healthy; each test makes auto-merge's newest run a refusal on
// the feed's way to the app.

async function refusedMerge(page: Page): Promise<void> {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    const t = feed.scheduled.tasks?.find((x) => x.id === "auto-merge");
    if (t && t.recent[0]) {
      t.flag = "failing";
      t.recent[0] = { ...t.recent[0], outcome: "refused", reason: "the policy document does not name required_checks, which this Worker enforces." };
    }
    await route.fulfill({ response: res, json: feed });
  });
}

test("Incidents lists every scheduled task with its state, its last run and what it did", async ({ page }) => {
  await refusedMerge(page);
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
  await refusedMerge(page);
  await visit(page, "needs");
  await expect(page.locator("main section.attention").getByText("Auto-merge step: its last run refused")).toBeVisible();
});
