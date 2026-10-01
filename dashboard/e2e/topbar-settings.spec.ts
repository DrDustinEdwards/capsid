import { expect, test } from "@playwright/test";
import { RAIL_COUNT, visit } from "./views.ts";

// Settings is the top bar's button, not a view in the left menu (Dustin, 2026-10-01): to
// the right of the theme button and before Sign out, with a tooltip, current on the
// Settings view. It keeps its g then e shortcut and its command-menu entry. On a phone it
// is under More.

const topSettings = (page: import("@playwright/test").Page) => page.locator("header.top").getByRole("link", { name: "Settings", exact: true });

test("PLANT: Settings is in the top bar, after the theme button and before Sign out, and not in the left menu", async ({ page }) => {
  await visit(page, "overview");
  await expect(page.locator("nav.rail a")).toHaveCount(RAIL_COUNT);
  await expect(page.locator("nav.rail a").filter({ hasText: /^Settings/ })).toHaveCount(0);
  await expect(topSettings(page)).toBeVisible();
  // The order in the top bar: the theme button, then Settings, then Sign out.
  const names = await page.locator("header.top").evaluate((h) =>
    [...h.querySelectorAll<HTMLElement>("a, button")].map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""),
  );
  const theme = names.indexOf("Dark theme");
  expect(theme).toBeGreaterThan(-1);
  expect(names[theme + 1]).toBe("Settings");
  expect(names[theme + 2]).toBe("Sign out");
});

test("PLANT: the Settings button has a tooltip and is current on the Settings view only", async ({ page }) => {
  await visit(page, "overview");
  await expect(topSettings(page)).not.toHaveAttribute("aria-current", "page");
  await topSettings(page).focus();
  await expect(page.locator(".tip.on")).toHaveText("Settings (g e)");
  await topSettings(page).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(topSettings(page)).toHaveAttribute("aria-current", "page");
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

  test("PLANT: Settings is under More, not in the top bar", async ({ page }) => {
    await visit(page, "overview");
    await expect(topSettings(page)).toBeHidden();
    await page.locator("nav.tabbar").getByRole("button", { name: "More" }).tap();
    const link = page.getByRole("dialog").getByRole("link", { name: /^Settings/ });
    await expect(link).toBeVisible();
    await link.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });
});
