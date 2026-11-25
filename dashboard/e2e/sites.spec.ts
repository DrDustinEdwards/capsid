import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

const NS = "sample-i";
const settings = (page: Page) => page.locator("main section#settings");

async function openSetup(page: Page) {
  await page.goto(`sites/${NS}?tab=setup`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("main .cap-spinner[data-layout='page']")).toHaveCount(0);
}

async function openAdd(page: Page) {
  await visit(page, "sites");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Add a site" })).toBeVisible();
}

test.describe.serial("the site configuration", () => {
  test("add a site on Sites: preview, Add site, and its own page shows its settings", async ({
    page,
  }) => {
    await openAdd(page);
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
    await expect(page.getByRole("heading", { level: 2, name: "Add a site" })).toHaveCount(0);
    await page.locator("main").getByRole("link", { name: "Sample I", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sample I" })).toBeVisible();
    await page.getByRole("link", { name: "Setup", exact: true }).click();
    await expect(settings(page)).toContainText("https://sample-i.example.com");
    await expect(settings(page)).toContainText("/health");
  });

  test("edit on Setup: the form opens filled in, and the change shows with a new revision", async ({
    page,
  }) => {
    await openSetup(page);
    await settings(page)
      .getByRole("button", { name: `Edit ${NS}` })
      .click();
    await expect(page.getByRole("heading", { level: 2, name: `Edit ${NS}` })).toBeVisible();
    await expect(page.getByLabel("Origin", { exact: true })).toHaveValue(
      "https://sample-i.example.com",
    );
    await page.getByLabel("Name", { exact: true }).fill("Sample I renamed");
    await page.getByLabel("Platform", { exact: true }).selectOption("vercel");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText('name: "Sample I" -> "Sample I renamed"');
    await expect(dialog).toContainText("revision 1 -> 2");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Sample I renamed" })).toBeVisible();
    await expect(settings(page)).toContainText("Vercel");
    await expect(settings(page).locator("[data-revision]")).toHaveText("2");
  });

  test("a refusal from the server is shown in the dialog, verbatim", async ({ page }) => {
    await openAdd(page);
    await page.getByLabel("Project", { exact: true }).fill("sample-j");
    await page.getByLabel("Origin", { exact: true }).fill("http://sample-j.example.com");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toHaveText(
      "the origin must start with https://; got 'http://sample-j.example.com'.",
    );
    await expect(dialog.getByRole("button", { name: "Add site", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByLabel("Origin", { exact: true })).toHaveValue(
      "http://sample-j.example.com",
    );
  });

  test("remove on Setup", async ({ page }) => {
    await openSetup(page);
    await expect(settings(page).getByRole("button", { name: `Remove ${NS}` })).toHaveCount(0);
    await settings(page)
      .getByRole("button", { name: `Edit ${NS}` })
      .click();
    await page
      .getByRole("group", { name: "Danger" })
      .getByRole("button", { name: `Remove ${NS}` })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`ops_sites: remove ${NS}`);
    await dialog.getByRole("button", { name: "Remove site", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.locator("main")).toContainText("No site has this name.");
  });
});
