import { expect, test, type Page } from "@playwright/test";
import { RAIL_PREF } from "../src/lib/prefs.ts";
import { RAIL_COUNT, RAIL_VIEWS, visit } from "./views.ts";

// The shell's menu (Capsomer 0.9.0's AdminShell, owner variant): a grouped menu beside the strip
// of apps, under the site header that holds Search, the inbox, the theme and the avatar.
// Collapsing folds the menu to icons; the control is a real button in the same place in both
// states, and the choice is remembered per browser.

const toggle = (page: Page) => page.locator("button[data-cap-part='menu-toggle']");
const menu = (page: Page) => page.locator("nav.cap-admin-menu");
const menuLinks = (page: Page) => page.locator("nav.cap-admin-menu a");
const label = (page: Page, text: string) => menu(page).locator(".cap-admin-label", { hasText: new RegExp(`^${text}$`) });

test.use({ viewport: { width: 1280, height: 900 } });

test("collapsing shrinks the menu to icons: same order, same places, labels and headings hidden, names and badges kept", async ({ page }) => {
  await visit(page, "health");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(menuLinks(page)).toHaveCount(RAIL_COUNT);
  for (const v of RAIL_VIEWS) await expect(label(page, v.label)).toBeVisible();
  const open = (await menu(page).boundingBox())!.width;
  const strip = page.locator("nav.cap-admin-strip");
  const stripOpen = await strip.boundingBox();
  const at = await toggle(page).boundingBox();
  const places = () =>
    menuLinks(page).evaluateAll((els) =>
      els.map((a) => {
        // Measured from the menu's top, so a scroll between the two readings changes nothing.
        const top = a.closest("nav")!.getBoundingClientRect().top;
        const r = a.getBoundingClientRect();
        return { name: a.getAttribute("aria-label") ?? a.querySelector(".cap-admin-label")?.textContent?.trim(), y: Math.round(r.top - top), h: Math.round(r.height) };
      }),
    );
  const before = await places();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(menu(page)).toBeVisible();
  expect((await menu(page).boundingBox())!.width).toBeLessThan(open / 2);
  expect((await strip.boundingBox())?.width).toBeCloseTo(stripOpen!.width, 0);
  expect(await places()).toEqual(before);
  // Labels keep their names for a screen reader but are clipped away; group headings become a divider.
  for (const l of await menu(page).locator(".cap-admin-label").all()) await expect(l).toHaveCSS("clip-path", "inset(50%)");
  for (const head of await menu(page).locator(".cap-admin-group-label").all()) await expect(head).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  // Names kept, a badge on each icon that has a count, the current page still dark filled.
  for (const v of RAIL_VIEWS) await expect(menu(page).getByRole("link", { name: new RegExp(`^${v.label}`) })).toHaveCount(1);
  await expect(menu(page).locator(".cap-admin-count:not(:empty)").first()).toBeVisible();
  await expect(menu(page).locator("a[aria-current='page']")).toHaveCount(1);
  const moved = await toggle(page).boundingBox();
  expect(moved!.x).toBeCloseTo(at!.x, 0);
  expect(moved!.y).toBeCloseTo(at!.y, 0);
});

test("a collapsed icon shows its label on hover and on keyboard focus", async ({ page }) => {
  await visit(page, "health");
  await toggle(page).click();
  const queue = menu(page).getByRole("link", { name: /^Queue/ });
  const tip = queue.locator(".cap-admin-tip");
  await expect(tip).toBeHidden();
  await queue.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText("Queue");
  await page.mouse.move(900, 500);
  await expect(tip).toBeHidden();
  // A key press first, so the focus that follows counts as keyboard focus (:focus-visible).
  await page.keyboard.press("Shift");
  await queue.focus();
  await expect(tip).toBeVisible();
});

test("the header's controls each have an accessible name and show it, with the key, on hover and focus", async ({ page }) => {
  await visit(page, "health");
  const header = page.locator("header.cap-site-header");
  const strip = page.locator("nav.cap-admin-strip");
  for (const name of ["Search everything", "Switch to dark theme", "Your account"]) await expect(header.getByRole("button", { name })).toHaveCount(1);
  await expect(header.getByRole("link", { name: /^Inbox/ })).toHaveCount(1);
  // Help is the avatar's menu's, not a control of its own.
  await expect(header.getByRole("button", { name: "Help and shortcuts" })).toBeHidden();
  await header.getByRole("button", { name: "Your account" }).click();
  await expect(header.getByRole("button", { name: "Help and shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  const search = header.getByRole("button", { name: "Search everything" });
  await search.hover();
  await expect(search.locator(".cap-site-header-tip")).toBeVisible();
  await expect(search.locator(".cap-site-header-tip kbd")).toHaveText(["Ctrl", "K"]);
  await page.mouse.move(700, 500);
  await toggle(page).focus();
  await expect(toggle(page).locator(".cap-admin-tip")).toContainText("[");
  // The app you are in: the dark tile, with no badge on it.
  await expect(strip.locator("a[aria-current='true']")).toHaveCount(1);
  await expect(strip.locator("a[aria-current='true'] .cap-admin-badge")).toHaveCount(0);
});

test("a count on a menu entry says what it counts in the entry's name", async ({ page }) => {
  await visit(page, "health");
  let counted = 0;
  for (const v of RAIL_VIEWS) {
    const link = menuLinks(page).filter({ has: page.getByText(v.label, { exact: true }) });
    await expect(link, `${v.label} is in the menu once`).toHaveCount(1);
    const name = await link.evaluate((el) => el.getAttribute("aria-label") ?? el.querySelector(".cap-admin-label")?.textContent ?? "");
    expect(name.startsWith(v.label), `${v.label}: accessible name is "${name}"`).toBe(true);
    await expect(menu(page).getByRole("link", { name: name.trim() })).toHaveCount(1);
    const n = (await link.locator(".cap-admin-count").textContent())?.trim() ?? "";
    if (n) {
      counted++;
      expect(name).toContain(`, ${n} `);
    }
  }
  // Health's critical problems only: what waits on you is the header inbox's number and
  // Needs you's list, so Pull requests carries no count of its own (UX audit m2).
  expect(counted).toBe(1);
  await expect(menuLinks(page).filter({ has: page.getByText("Pull requests", { exact: true }) }).locator(".cap-admin-count:not(:empty)")).toHaveCount(0);
});

test("the state survives a reload", async ({ page }) => {
  await visit(page, "queue");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_PREF)).toBe("collapsed");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  const collapsed = (await menu(page).boundingBox())!.width;
  await toggle(page).click();
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  expect((await menu(page).boundingBox())!.width).toBeGreaterThan(collapsed * 2);
});

test("it works by keyboard: Tab reaches it, Enter and Space toggle it, and [ does too", async ({ page }) => {
  await visit(page, "health");
  await page.locator("body").click({ position: { x: 600, y: 5 } });
  let reached = false;
  for (let i = 0; i < 200 && !reached; i++) {
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
  await visit(page, "health");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { level: 1, name: "Health" })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a collapsed menu does not change the bottom tab bar", async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, "collapsed"), RAIL_PREF);
    await visit(page, "health");
    await expect(menu(page)).toBeHidden();
    await expect(page.locator("nav.cap-admin-strip")).toBeHidden();
    const tabs = page.locator("nav.cap-site-tabs a");
    await expect(tabs).toHaveCount(3);
    for (const t of await tabs.all()) await expect(t).toBeInViewport({ ratio: 1 });
  });
});
