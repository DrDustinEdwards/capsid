import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { RAIL_COUNT, visit } from "./views.ts";

// The optional Packages view (capsid/decisions.md, 2026-09-29) against the dev mock,
// whose fixture configures one made-up package, sample-pkg, formerly sample-old.

test("the Packages view shows each configured package as the watcher last read it", async ({ page }) => {
  await visit(page, "packages");
  const panel = page.locator('[data-package="sample-pkg"]');
  await expect(panel).toContainText("0.3.0");
  await expect(panel).toContainText("41 in 7 days");
  await expect(panel).toContainText("188 in 30 days");
  await expect(panel).toContainText("Per version, last 7 days only");
  await expect(panel).toContainText("7 packages depend on 0.3.0: 2 directly, 5 through another package");
  await expect(panel.getByRole("link", { name: "npm's list" })).toHaveAttribute("href", "https://www.npmjs.com/package/sample-pkg?activeTab=dependents");
  await expect(panel).toContainText("example-org/sample-pkg");
  await expect(panel).toContainText("sample-old");
});

test("the download history is fetched when asked for, joined to the former name, with the weekly GitHub rows", async ({ page }) => {
  await visit(page, "packages");
  const panel = page.locator('[data-package="sample-pkg"]');
  await expect(panel.locator("[data-history]")).toHaveCount(0);
  await panel.getByRole("button", { name: "Load the daily download history" }).click();
  const history = panel.locator('[data-history="sample-pkg"]');
  await expect(history.getByRole("img")).toHaveAttribute("aria-label", /Daily downloads of sample-pkg and its former name sample-old/);
  await expect(history).toContainText("sample-old:");
  await expect(history).toContainText("sample-pkg:");
  await expect(history.locator("table tbody tr")).toHaveCount(2);
});

test("a package is added from Settings through the confirm dialog, and removed again", async ({ page }) => {
  await visit(page, "settings");
  await page.getByRole("button", { name: "Add package", exact: true }).click();
  await page.getByLabel("npm name", { exact: true }).fill("sample-extra");
  await page.getByLabel("GitHub repository", { exact: true }).fill("example-org/sample-extra");
  await page.getByRole("button", { name: "Preview the add", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText('ops_packages: add npm "sample-extra", repository example-org/sample-extra');
  await dialog.getByRole("button", { name: "Add package", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const row = page.locator('main tr[data-package="sample-extra"]');
  await expect(row).toHaveCount(1);
  // Remove is not beside Edit: it is in the edit form's Danger area (UX audit M9).
  await expect(row.getByRole("button", { name: "Remove sample-extra" })).toHaveCount(0);
  await row.getByRole("button", { name: "Edit sample-extra" }).click();
  await page.getByRole("group", { name: "Danger" }).getByRole("button", { name: "Remove sample-extra" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove package", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(row).toHaveCount(0);
});

async function withoutPackages(page: Page) {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.packages = [];
    await route.fulfill({ response: res, json: feed });
  });
}

test("with no package configured, Packages has only its Shared tab", async ({ page }) => {
  await withoutPackages(page);
  await visit(page, "health");
  await expect(page.locator("nav.cap-admin-menu a")).toHaveCount(RAIL_COUNT);
  await page.goto("./packages");
  await expect(page.getByRole("heading", { level: 1, name: "Packages" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Packages", exact: true }).getByRole("link");
  await expect(tabs).toHaveText(["Shared"]);
  await expect(tabs.first()).toHaveAttribute("aria-current", "page");
});

// UX audit m1: one page for one kind of thing. Published and Shared are tabs of Packages,
// and the old Shared code address lands on its tab.
test("Packages has Published and Shared tabs, and /shared opens the Shared tab", async ({ page }) => {
  await visit(page, "packages");
  const tabs = page.getByRole("navigation", { name: "Packages", exact: true });
  await expect(tabs.getByRole("link")).toHaveText(["Published", "Shared"]);
  await expect(tabs.getByRole("link", { name: "Published" })).toHaveAttribute("aria-current", "page");
  await page.goto("./shared");
  await expect(page).toHaveURL(/\/packages\?tab=shared$/);
  await expect(tabs.getByRole("link", { name: "Shared" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Packages" })).toBeVisible();
});
