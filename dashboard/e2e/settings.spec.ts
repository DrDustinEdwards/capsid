import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// The Settings view: the site configuration, edited through the confirm dialog, against
// the production build and the dev mock (dev/mock-api.ts), which keeps changes in memory
// for the life of the preview server. The tests run in order on one namespace the mock has
// registered with no row (sample-i), and leave the configuration as they found it.

const NS = "sample-i";
const row = (page: Page, ns = NS) => page.locator("main tr[data-row]").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${ns}$`) }) });

async function openAdd(page: Page) {
  await visit(page, "settings");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Add a site" })).toBeVisible();
}

test.describe.serial("the site configuration", () => {
  test("add a site through the form: preview, Add site, and the row appears", async ({ page }) => {
    await openAdd(page);
    await expect(row(page)).toHaveCount(0);
    await page.getByLabel("Project", { exact: true }).fill(NS);
    await page.getByLabel("Name", { exact: true }).fill("Sample I");
    await page.getByLabel("Origin", { exact: true }).fill("https://sample-i.example.com");
    await page.getByLabel("Health path", { exact: true }).fill("/health");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Details", { exact: true }).click();
    await expect(dialog.getByText("What changes")).toBeVisible();
    await expect(dialog).toContainText("ops_sites: add sample-i");
    await dialog.getByRole("button", { name: "Add site", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toContainText("https://sample-i.example.com");
    await expect(row(page)).toContainText("/health");
    // The form closed once the change was made.
    await expect(page.getByRole("heading", { level: 2, name: "Add a site" })).toHaveCount(0);
  });

  test("edit a row: the form opens filled in, and the change shows with a new revision", async ({ page }) => {
    await visit(page, "settings");
    await row(page).getByRole("button", { name: `Edit ${NS}` }).click();
    await expect(page.getByRole("heading", { level: 2, name: `Edit ${NS}` })).toBeVisible();
    await expect(page.getByLabel("Origin", { exact: true })).toHaveValue("https://sample-i.example.com");
    await page.getByLabel("Name", { exact: true }).fill("Sample I renamed");
    await page.getByLabel("Platform", { exact: true }).selectOption("vercel");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText('name: "Sample I" -> "Sample I renamed"');
    await expect(dialog).toContainText("revision 1 -> 2");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(row(page)).toContainText("Sample I renamed");
    await expect(row(page)).toContainText("Vercel");
    await expect(row(page).locator('td[data-label="Revision"] .num')).toHaveText("2");
  });

  test("a refusal from the server is shown in the dialog, verbatim", async ({ page }) => {
    await openAdd(page);
    await page.getByLabel("Project", { exact: true }).fill("sample-j");
    await page.getByLabel("Origin", { exact: true }).fill("http://sample-j.example.com");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toHaveText("the origin must start with https://; got 'http://sample-j.example.com'.");
    await expect(dialog.getByRole("button", { name: "Add site", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // Cancel keeps what was typed.
    await expect(page.getByLabel("Origin", { exact: true })).toHaveValue("http://sample-j.example.com");
  });

  test("remove a row", async ({ page }) => {
    await visit(page, "settings");
    // Remove is in the edit form's Danger area, not beside Edit (UX audit M9).
    await expect(row(page).getByRole("button", { name: `Remove ${NS}` })).toHaveCount(0);
    await row(page).getByRole("button", { name: `Edit ${NS}` }).click();
    await page.getByRole("group", { name: "Danger" }).getByRole("button", { name: `Remove ${NS}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`ops_sites: remove ${NS}`);
    await dialog.getByRole("button", { name: "Remove site", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(row(page)).toHaveCount(0);
  });
});
