import { expect, test, type Page } from "@playwright/test";
import { RAIL_PREF } from "../src/lib/prefs.ts";
import { ALL_VIEWS, VIEW_COUNT, visit } from "./views.ts";

// The collapsible side menu (the rail): a real button, remembered per browser, icons in
// the same column as the header logo in both states.

const toggle = (page: Page) => page.locator("nav.rail button[aria-controls='rail']");
const railLinks = (page: Page) => page.locator("nav.rail a");

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height, center: r.left + r.width / 2 };
    };
    const logo = document.querySelector(".top .brand svg");
    const rail = document.querySelector("nav.rail");
    return {
      logo: logo ? box(logo) : null,
      rail: rail ? box(rail) : null,
      icons: Array.from(document.querySelectorAll("nav.rail a > svg"), box),
      buttonIcons: Array.from(document.querySelectorAll("nav.rail .railbtn > svg"), box),
      labels: Array.from(document.querySelectorAll("nav.rail a > .lbl"), box),
    };
  });
}

// The logo and every rail icon sit in one column: the rail icons share a left edge, and
// their centre is the logo's centre (the logo is 24 px, the icons 16, so their left
// edges differ by 4 px by design; that is the alignment the menu had before this change).
function expectOneColumn(g: Awaited<ReturnType<typeof geometry>>, state: string) {
  expect(g.logo, `${state}: no header logo`).not.toBeNull();
  expect(g.logo!.width).toBeGreaterThan(0);
  expect(g.icons, `${state}: one icon per view`).toHaveLength(VIEW_COUNT);
  const left = g.icons[0]!.left;
  for (const i of g.icons) {
    expect(i.width, `${state}: an icon is not drawn`).toBeGreaterThan(0);
    expect(Math.abs(i.left - left), `${state}: rail icons do not share a left edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(i.center - g.logo!.center), `${state}: a rail icon is off the logo's column`).toBeLessThanOrEqual(1);
    expect(i.right, `${state}: an icon is outside the rail`).toBeLessThanOrEqual(g.rail!.right);
  }
  for (const i of g.buttonIcons) expect(Math.abs(i.center - g.logo!.center), `${state}: a rail button icon is off the column`).toBeLessThanOrEqual(1);
}

test.use({ viewport: { width: 1280, height: 900 } });

test("collapsing hides the labels and keeps the logo and every icon, in one column", async ({ page }) => {
  await visit(page, "overview");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  const open = await geometry(page);
  expectOneColumn(open, "expanded");
  expect(open.rail!.width).toBeCloseTo(208, 0);
  for (const l of open.labels) expect(l.width).toBeGreaterThan(20);
  for (const v of ALL_VIEWS) await expect(page.locator("nav.rail").getByText(v.label, { exact: true })).toBeVisible();

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  const shut = await geometry(page);
  expectOneColumn(shut, "collapsed");
  expect(shut.rail!.width).toBeCloseTo(56, 0);
  expect(shut.labels).toHaveLength(VIEW_COUNT);
  // Visually hidden, still in the accessibility tree.
  for (const l of shut.labels) expect(l.width).toBeLessThanOrEqual(1);
  await expect(page.locator(".top .brand svg")).toBeVisible();
  for (const icon of await page.locator("nav.rail a > svg").all()) await expect(icon).toBeVisible();
  // The icons did not move.
  expect(Math.abs(shut.icons[0]!.left - open.icons[0]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(shut.logo!.left - open.logo!.left)).toBeLessThanOrEqual(1);
});

test("collapsed, every icon has a tooltip and an accessible name, and a count shows as a dot", async ({ page }) => {
  await visit(page, "overview");
  await toggle(page).click();
  await expect(railLinks(page)).toHaveCount(VIEW_COUNT);
  let counted = 0;
  for (const [i, v] of ALL_VIEWS.entries()) {
    const link = railLinks(page).nth(i);
    const name = await link.evaluate((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    expect(name.startsWith(v.label), `${v.label}: accessible name is "${name}"`).toBe(true);
    await expect(page.locator("nav.rail").getByRole("link", { name: name.trim() })).toHaveCount(1);
    const tip = await link.getAttribute("data-tip");
    expect(tip, `${v.label}: no tooltip`).toBeTruthy();
    expect(tip!.startsWith(v.label)).toBe(true);
    const count = link.locator(".count");
    const n = (await count.textContent())?.trim() ?? "";
    if (n) {
      counted++;
      // The number is in the name and the tooltip; the dot is drawn.
      expect(name).toContain(`, ${n} `);
      expect(tip).toBe(name);
      const dot = await count.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, bg: getComputedStyle(el).backgroundColor };
      });
      expect(dot.w).toBeGreaterThanOrEqual(6);
      expect(dot.h).toBeGreaterThanOrEqual(6);
      expect(dot.bg).not.toBe("rgba(0, 0, 0, 0)");
    }
  }
  // The sample feed has counts on several views; with none the dot checks would be vacuous.
  expect(counted).toBeGreaterThanOrEqual(3);

  // The tooltip shows on hover and on keyboard focus, beside the icon.
  const sites = railLinks(page).nth(ALL_VIEWS.findIndex((v) => v.id === "sites"));
  await sites.hover();
  await expect(page.locator(".tip.on")).toHaveText((await sites.getAttribute("data-tip"))!);
  const tipBox = await page.locator(".tip.on").boundingBox();
  const railBox = await page.locator("nav.rail").boundingBox();
  expect(tipBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width);
  await page.mouse.move(700, 500);
  const queue = railLinks(page).nth(ALL_VIEWS.findIndex((v) => v.id === "queue"));
  await queue.focus();
  await expect(page.locator(".tip.on")).toHaveText((await queue.getAttribute("data-tip"))!);
});

test("the state survives a reload", async ({ page }) => {
  await visit(page, "sites");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_PREF)).toBe("collapsed");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect((await geometry(page)).rail!.width).toBeCloseTo(56, 0);
  await toggle(page).click();
  await page.reload();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  expect((await geometry(page)).rail!.width).toBeCloseTo(208, 0);
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
  // A visible focus ring.
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
  // The toggle still works for this page load; the failed write is not fatal.
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
    await expect(page.locator("nav.rail")).toBeHidden();
    const tabs = page.locator("nav.tabbar > a, nav.tabbar > button");
    await expect(tabs).toHaveCount(5);
    for (const t of await tabs.all()) await expect(t).toBeInViewport({ ratio: 1 });
    await expect(page.locator(".top .brand")).toContainText("Capsid Portal");
  });
});
