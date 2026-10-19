import { expect, test, type Page } from "@playwright/test";
import { RAIL_COUNT, visit } from "./views.ts";

// Settings is the side menu's last entry, with a gear (the Portal UX audit's M4: it was
// only under the avatar). The avatar's account panel still has it, current on the Settings
// view, and it keeps its g then e shortcut and its command-menu entry.

const openAccount = async (page: Page) => {
  await page.getByRole("button", { name: "Your account" }).click();
  return page.locator(".cap-site-header-account");
};

test("PLANT: Settings is the menu's last entry, with an icon", async ({ page }) => {
  await visit(page, "health");
  const links = page.locator("nav.cap-admin-menu a");
  await expect(links).toHaveCount(RAIL_COUNT);
  await expect(links.last()).toHaveText(/^Settings/);
  await expect(links.last().locator("svg path")).not.toHaveCount(0);
  await links.last().click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(links.last()).toHaveAttribute("aria-current", "page");
});

test("every menu entry has an icon, so the collapsed menu has no blank button", async ({ page }) => {
  await visit(page, "health");
  for (const a of await page.locator("nav.cap-admin-menu a").all()) {
    await expect(a.locator("svg path, svg circle").first(), `${await a.innerText()} has an icon`).toBeAttached();
  }
});

test("PLANT: the Settings link under the avatar is current on the Settings view only", async ({ page }) => {
  await visit(page, "health");
  let panel = await openAccount(page);
  await expect(panel.getByRole("link", { name: "Portal settings" })).not.toHaveAttribute("aria-current", "page");
  await panel.getByRole("link", { name: "Portal settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  panel = await openAccount(page);
  await expect(panel.getByRole("link", { name: "Portal settings" })).toHaveAttribute("aria-current", "page");
  await expect(panel.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("PLANT: g then e and the command menu still reach Settings", async ({ page }) => {
  await visit(page, "health");
  await page.keyboard.press("g");
  await page.keyboard.press("e");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await visit(page, "health");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("settings");
  await expect(page.getByRole("option").filter({ hasText: "Settings" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("Settings puts Automation first", async ({ page }) => {
  await visit(page, "settings");
  const heads = page.locator("main .cap-panel-head h2");
  await expect(heads.first()).toHaveText("Automation");
  const all = await heads.allInnerTexts();
  expect(all.indexOf("Automation")).toBeLessThan(all.indexOf("Sites"));
  expect(all.indexOf("Phone alerts")).toBeLessThan(all.indexOf("Sites"));
  expect(all.indexOf("Projects")).toBeGreaterThan(all.indexOf("Packages"));
  expect(all.at(-1)).toBe("Display");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("PLANT: Settings is in the sheet behind the menu button", async ({ page }) => {
    await visit(page, "health");
    await page.locator("header.cap-site-header").getByRole("button", { name: "Menu" }).tap();
    const link = page.getByRole("dialog").getByRole("link", { name: /^Settings/ }).first();
    await expect(link).toBeVisible();
    await link.tap();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
