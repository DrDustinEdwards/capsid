import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// Live sessions from the hook receiver (POST /ops/hooks) against the dev mock, whose
// sample feed carries three: a runner session that just stopped a turn, a driver
// session waiting on a permission prompt for 25 minutes (an incident), and a session
// stopped on a rate limit with no job bound (an incident).

const panel = (page: Page) => page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Live sessions" }) });
const rows = (page: Page) => panel(page).locator("[data-session]");

// A row names its session's job by title and opens that job; the ids are in the drawer
// (design D11).
test("the Queue lists each live session with its job, key, last event and state", async ({ page }) => {
  await visit(page, "queue");
  await expect(rows(page)).toHaveCount(3);
  const running = rows(page).and(page.locator('[data-open="job:job_91b3c0de5a24"]'));
  await expect(running).toContainText("Design only: paired comparison for the methods note");
  await expect(running).toContainText("Running");
  // A runner's key name carries its job id, so the row calls it a runner.
  await expect(running).toContainText("a seat-started runner");
  await expect(running).toContainText("Stop");
  const waiting = rows(page).and(page.locator('[data-open="job:job_e946e3196ab8"]'));
  await expect(waiting).toContainText("Operations dashboard: every site in one view");
  await expect(waiting).toContainText("Needs input");
  await expect(waiting).toContainText("agent:sample-driver");
  await expect(waiting).toContainText("permission_prompt");
  const failed = rows(page).filter({ hasText: "No job bound" });
  await expect(failed).toContainText("Failed");
  await expect(failed).toContainText("failure: rate_limit");
  await expect(panel(page)).not.toContainText("job_");
});

test("a session waiting too long and a session stopped on a rate limit are incidents", async ({ page }) => {
  await visit(page, "incidents");
  const feed = page.locator("main .feed");
  await expect(feed.getByText('Session for "Operations dashboard: every site in one view" is waiting on input')).toBeVisible();
  await expect(feed.getByText("Session for agent:sample-b-driver stopped: rate_limit")).toBeVisible();
  // The running session is not one.
  await expect(feed.getByText("Design only: paired comparison for the methods note")).toHaveCount(0);
});
