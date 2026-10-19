import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The phone tab bar (ruled 2026-09-30, DECIDE 12; the Portal UX audit's sitemap, 2026-10):
// Needs you, Health and Pull requests, the pages a person opens most. Capsomer has no Menu
// tab yet: the header's menu button opens a sheet listing every page with its count, so no
// view needs the command menu to be reached on a phone.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("PLANT: the tab bar is exactly Needs you, Health and Pull requests", async ({ page }) => {
  await visit(page, "queue");
  const tabs = page.locator("nav.cap-site-tabs a");
  // A tab's count follows its name ("Health3"), so each name is matched at the start.
  await expect(tabs).toHaveText([/^Needs you/, /^Health/, /^Pull requests/]);
  await expect(tabs).toHaveCount(3);
  for (const t of await tabs.all()) await expect(t).toBeInViewport({ ratio: 1 });
});

test("PLANT: the menu button lists every page, Settings last; Esc closes it and focus returns to the button", async ({ page }) => {
  await visit(page, "health");
  const more = page.locator("header.cap-site-header").getByRole("button", { name: "Menu" });
  await more.tap();
  const sheet = page.getByRole("dialog", { name: "Capsid Portal menu" });
  await expect(sheet).toBeVisible();
  for (const name of ["Needs you", "Health", "Pull requests", "Jobs", "Activity", "Agents", "Packages", "Library", "Settings"]) {
    await expect(sheet.getByRole("link", { name: new RegExp(`^${name}`) }).first()).toBeVisible();
  }
  await expect(sheet.getByRole("link", { name: /^Shared code/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  await more.tap();
  await sheet.getByRole("link", { name: /^Settings/ }).first().tap();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(sheet).toBeHidden();
});
