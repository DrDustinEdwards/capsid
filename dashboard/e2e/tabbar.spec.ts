import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The phone tab bar (ruled 2026-09-30, DECIDE 12; Needs you replaced Overview as the home
// on 2026-10-09, and Health took Incidents' and Sites' places when the eight pages came the
// same day): Needs you, Queue, Health. Capsomer 0.9.0 dropped More: the header's menu button
// opens a sheet listing every page with its count, so no view needs the command menu to be
// reached on a phone.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("PLANT: the tab bar is exactly Needs you, Queue and Health", async ({ page }) => {
  await visit(page, "queue");
  const tabs = page.locator("nav.cap-site-tabs a");
  // A tab's count follows its name ("Queue3"), so each name is matched at the start.
  await expect(tabs).toHaveText([/^Needs you/, /^Queue/, /^Health/]);
  await expect(tabs).toHaveCount(3);
  for (const t of await tabs.all()) await expect(t).toBeInViewport({ ratio: 1 });
});

test("PLANT: the menu button lists every page and reaches Settings; Esc closes it and focus returns to the button", async ({ page }) => {
  await visit(page, "health");
  const more = page.locator("header.cap-site-header").getByRole("button", { name: "Menu" });
  await more.tap();
  const sheet = page.getByRole("dialog", { name: "Capsid Portal menu" });
  await expect(sheet).toBeVisible();
  for (const name of ["Needs you", "Health", "Queue", "Pull requests", "Activity", "Agents", "Packages", "Shared code"]) {
    await expect(sheet.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(sheet.getByRole("link", { name: /^Portal settings/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  await more.tap();
  await sheet.getByRole("link", { name: /^Portal settings/ }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(sheet).toBeHidden();
});
