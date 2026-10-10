import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The phone tab bar (ruled 2026-09-30, DECIDE 12; Needs you replaced Overview as the home
// on 2026-10-09): Needs you, Queue, Incidents, Sites,
// More. More opens a sheet listing every other view with its count, so no view needs the
// command menu to be reached on a phone.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("PLANT: the tab bar is exactly Needs you, Queue, Incidents, Sites and More", async ({ page }) => {
  await visit(page, "overview");
  const tabs = page.locator("nav.cap-admin-tabs > a, nav.cap-admin-tabs > button");
  // A tab's count follows its name ("Queue3"), so each name is matched at the start.
  await expect(tabs).toHaveText([/^Needs you/, /^Queue/, /^Incidents/, /^Sites/, /^More$/]);
  await expect(tabs).toHaveCount(5);
  for (const t of await tabs.all()) await expect(t).toBeInViewport({ ratio: 1 });
});

test("PLANT: More lists the other views and reaches Namespaces; Esc closes it and focus returns to More", async ({ page }) => {
  await visit(page, "overview");
  const more = page.locator("nav.cap-admin-tabs").getByRole("button", { name: "More" });
  await more.tap();
  const sheet = page.getByRole("dialog", { name: /apps and more/ });
  await expect(sheet).toBeVisible();
  // Every view but the four tabs.
  for (const name of ["Overview", "Deploys", "Agents", "Backups", "CI and merges", "Namespaces", "Activity", "Claims"]) {
    await expect(sheet.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(sheet.getByRole("link", { name: /^Portal settings/ })).toBeVisible();
  await expect(sheet.getByRole("link", { name: /^Needs you/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  await more.tap();
  await sheet.getByRole("link", { name: /^Namespaces/ }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "Namespaces" })).toBeVisible();
  await expect(sheet).toBeHidden();
});
