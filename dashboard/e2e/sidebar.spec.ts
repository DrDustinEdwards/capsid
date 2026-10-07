import { expect, test, type Page } from "@playwright/test";
import { RAIL_PREF } from "../src/lib/prefs.ts";
import { RAIL_COUNT, RAIL_VIEWS, visit } from "./views.ts";

// The shell's menu (Capsomer's AdminShell): a grouped menu beside the strip of apps and tools.
// Collapsing folds the menu away and leaves the strip; the control is a real button in the same
// place in both states, and the choice is remembered per browser.

const toggle = (page: Page) => page.locator("button[data-cap-part='menu-toggle']");
const menu = (page: Page) => page.locator("nav.cap-admin-menu");
const menuLinks = (page: Page) => page.locator("nav.cap-admin-menu a");

test.use({ viewport: { width: 1280, height: 900 } });

test("collapsing hides the menu, leaves the strip, and the control does not move", async ({ page }) => {
  await visit(page, "overview");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(menuLinks(page)).toHaveCount(RAIL_COUNT);
  for (const v of RAIL_VIEWS) await expect(menu(page).getByText(v.label, { exact: true })).toBeVisible();
  expect((await menu(page).boundingBox())?.width).toBeCloseTo(208, 0);
  const strip = page.locator("nav.cap-admin-strip");
  const stripOpen = await strip.boundingBox();
  const at = await toggle(page).boundingBox();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(menu(page)).toBeHidden();
  await expect(strip).toBeVisible();
  expect((await strip.boundingBox())?.width).toBeCloseTo(stripOpen!.width, 0);
  expect(stripOpen!.width).toBeCloseTo(56, 0);
  const moved = await toggle(page).boundingBox();
  expect(moved!.x).toBeCloseTo(at!.x, 0);
  expect(moved!.y).toBeCloseTo(at!.y, 0);
});

test("the strip's controls each have an accessible name and show it, with the key, on hover and focus", async ({ page }) => {
  await visit(page, "overview");
  const strip = page.locator("nav.cap-admin-strip");
  for (const name of ["Search everything", "Help and shortcuts", "Your account"]) await expect(strip.getByRole("button", { name })).toHaveCount(1);
  const search = strip.getByRole("button", { name: "Search everything" });
  await search.hover();
  await expect(search.locator(".cap-admin-tip")).toHaveCSS("opacity", "1");
  await expect(search.locator(".cap-admin-tip")).toContainText("Ctrl K");
  await page.mouse.move(700, 500);
  await toggle(page).focus();
  await expect(toggle(page).locator(".cap-admin-tip")).toContainText("[");
  // The app you are in: the dark tile, with no badge on it.
  await expect(strip.locator("a[aria-current='true']")).toHaveCount(1);
  await expect(strip.locator("a[aria-current='true'] .cap-admin-badge")).toHaveCount(0);
});

test("a count on a menu entry says what it counts in the entry's name", async ({ page }) => {
  await visit(page, "overview");
  let counted = 0;
  for (const v of RAIL_VIEWS) {
    const link = menuLinks(page).filter({ has: page.getByText(v.label, { exact: true }) });
    await expect(link, `${v.label} is in the menu once`).toHaveCount(1);
    const name = await link.evaluate((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    expect(name.startsWith(v.label), `${v.label}: accessible name is "${name}"`).toBe(true);
    await expect(menu(page).getByRole("link", { name: name.trim() })).toHaveCount(1);
    const n = (await link.locator(".cap-admin-count").textContent())?.trim() ?? "";
    if (n) {
      counted++;
      expect(name).toContain(`, ${n} `);
    }
  }
  expect(counted).toBeGreaterThanOrEqual(3);
});

test("the state survives a reload", async ({ page }) => {
  await visit(page, "sites");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_PREF)).toBe("collapsed");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(menu(page)).toBeHidden();
  await toggle(page).click();
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(menu(page)).toBeVisible();
});

test("it works by keyboard: Tab reaches it, Enter and Space toggle it, and [ does too", async ({ page }) => {
  await visit(page, "overview");
  await page.locator("body").click({ position: { x: 600, y: 5 } });
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await toggle(page).evaluate((el) => el === document.activeElement);
  }
  expect(reached, "Tab never reached the collapse button").toBe(true);
  const ring = await toggle(page).evaluate((el) => ({ visible: el.matches(":focus-visible"), style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
  expect(ring).toEqual({ visible: true, style: "solid", width: "2px" });
  await expect(toggle(page)).toHaveAccessibleName("Collapse menu");

  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAccessibleName("Expand menu");
  await page.keyboard.press("Space");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

  // The single-key shortcut, from anywhere outside a field; listed in the help sheet.
  await page.locator("main").focus();
  await page.keyboard.press("[");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("[");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard" });
  await expect(help).toBeVisible();
  await expect(help.getByText("Collapse or expand the side menu")).toBeVisible();
});

test("the app renders, expanded, when localStorage throws", async ({ page }) => {
  await page.addInitScript(() => {
    const boom = () => {
      throw new DOMException("storage is blocked", "SecurityError");
    };
    Object.defineProperty(Storage.prototype, "getItem", { value: boom, configurable: true });
    Object.defineProperty(Storage.prototype, "setItem", { value: boom, configurable: true });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await visit(page, "overview");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a collapsed menu does not change the bottom tab bar", async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, "collapsed"), RAIL_PREF);
    await visit(page, "overview");
    await expect(menu(page)).toBeHidden();
    await expect(page.locator("nav.cap-admin-strip")).toBeHidden();
    const tabs = page.locator("nav.cap-admin-tabs > a, nav.cap-admin-tabs > button");
    await expect(tabs).toHaveCount(5);
    for (const t of await tabs.all()) await expect(t).toBeInViewport({ ratio: 1 });
  });
});
