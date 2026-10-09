import { expect, test } from "@playwright/test";

// The stale view on the Queue (GET /portal/api/stale), against the production build and
// the dev mock. The journey: a stale row opens its job, and Resume carries the optional
// note to the preview with the reason (stale jobs D6). Nothing is performed, so the
// mock's state is left as every other spec reads it.

const PREVIEW_URL = "**/portal/api/actions/preview";

test("a stale row opens its job, and Resume sends the typed note with the reason", async ({ page }) => {
  await page.goto("queue");
  const row = page.locator('[data-rule="prs-settled"]').first();
  await expect(row).toBeVisible();
  const title = (await row.locator(".t b").textContent()) ?? "";
  await row.click();
  await expect(page.locator("dialog.drawer")).toContainText(title);

  let sent: { action?: string; params?: Record<string, string> } = {};
  await page.route(PREVIEW_URL, async (route) => {
    sent = route.request().postDataJSON();
    await route.continue();
  });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await dialog.getByLabel("Reason (required)").fill("the pull request merged");
  await dialog.getByLabel("Note for the driver (optional)").fill("Merged at abc1234.\nConfirm the deploy, then complete.");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("What changes")).toBeVisible();
  expect(sent.action).toBe("resume_job");
  expect(sent.params?.reason).toBe("the pull request merged");
  expect(sent.params?.note).toBe("Merged at abc1234.\nConfirm the deploy, then complete.");
});
