import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// A blocked job's command in the drawer, by what its signature says (src/job-signing.ts).
// The sample feed has a verified block and one written before blocks were signed.

async function openJob(page: import("@playwright/test").Page, id: string) {
  await visit(page, "queue");
  await page.locator(`main [data-open="job:${id}"]`).first().click();
  const drawer = page.locator("aside.drawer.on");
  await expect(drawer).toBeVisible();
  return drawer;
}

test("a verified command is shown with its Copy button and no warning", async ({ page }) => {
  const drawer = await openJob(page, "job_7c1e44b0a912");
  await expect(drawer.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect(drawer.locator("[data-signature]")).toHaveCount(0);
});

test("a command written before signing is shown, with an Unsigned note under it", async ({ page }) => {
  const drawer = await openJob(page, "job_15e10168e61c");
  await expect(drawer.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect(drawer.locator('[data-signature="legacy-unsigned"]')).toContainText("Unsigned");
});
