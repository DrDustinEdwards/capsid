import { expect, test } from "@playwright/test";

// The convergence view in Sites (GET /portal/api/convergence), against the production build
// and the dev mock. The journey that must never break: a drifted check's Run opens the
// site_repair control's preview, which names the operator route and never a token, and the
// perform settles the drift on the panel's next read.

test("Run on a drifted check previews the site_repair call, performs it, and the panel reads the check converged", async ({ page }) => {
  await page.goto("sites");
  const panel = page.locator('[data-convergence="sample-b"]').locator("xpath=ancestor::section[1]");
  const drifted = panel.locator('tr[data-check="pages-drift"]');
  await expect(drifted).toContainText("drifted");
  await expect(panel).toContainText("SMOKE_TOKEN");

  await drifted.getByRole("button", { name: "Run" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog.getByText("What changes")).toBeVisible();
  await expect(dialog).toContainText("POST https://sample-b.example.com/api/operator with tool sync_pages");
  await expect(dialog).toContainText("the token is never shown or recorded");
  await dialog.getByRole("button", { name: "Run sync_pages" }).click();

  await expect(drifted).toContainText("ok");
  await expect(panel.getByText("sync_pages", { exact: true }).last()).toBeVisible();
});
