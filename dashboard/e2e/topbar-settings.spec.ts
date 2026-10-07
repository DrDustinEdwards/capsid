import { expect, test, type Page } from "@playwright/test";
import { RAIL_COUNT, visit } from "./views.ts";

// Settings is not a view in the menu (Dustin, 2026-10-01): it is under the avatar's account panel,
// current on the Settings view. It keeps its g then e shortcut and its command-menu entry. On a
// phone it is in the sheet behind More.

const openAccount = async (page: Page) => {
  await page.getByRole("button", { name: "Your account" }).click();
  return page.locator(".cap-admin-account");
};

test("PLANT: Settings is under the avatar, not in the menu", async ({ page }) => {
  await visit(page, "overview");
  await expect(page.locator("nav.cap-admin-menu a")).toHaveCount(RAIL_COUNT);
  await expect(page.locator("nav.cap-admin-menu a").filter({ hasText: /^Settings/ })).toHaveCount(0);
  const panel = await openAccount(page);
  await expect(panel.getByRole("link", { name: "Portal settings" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("PLANT: the Settings link is current on the Settings view only", async ({ page }) => {
  await visit(page, "overview");
  let panel = await openAccount(page);
  await expect(panel.getByRole("link", { name: "Portal settings" })).not.toHaveAttribute("aria-current", "page");
  await panel.getByRole("link", { name: "Portal settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  panel = await openAccount(page);
  await expect(panel.getByRole("link", { name: "Portal settings" })).toHaveAttribute("aria-current", "page");
});

test("PLANT: g then e and the command menu still reach Settings", async ({ page }) => {
  await visit(page, "overview");
  await page.keyboard.press("g");
  await page.keyboard.press("e");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await visit(page, "overview");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("settings");
  await expect(page.getByRole("option").filter({ hasText: "Settings" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("PLANT: Settings is in the sheet behind More, and More is current on it", async ({ page }) => {
    await visit(page, "overview");
    await page.locator("nav.cap-admin-tabs").getByRole("button", { name: "More" }).tap();
    const link = page.getByRole("dialog").getByRole("link", { name: /^Portal settings/ });
    await expect(link).toBeVisible();
    await link.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.locator("nav.cap-admin-tabs").getByRole("button", { name: "More" })).toHaveAttribute("aria-current", "true");
  });
});
