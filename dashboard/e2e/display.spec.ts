import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// Display (ruled 2026-09-30, DECIDE 8 and 13): the top bar's theme button says whether
// dark is in effect; Settings offers System, Light and Dark, where System removes the
// saved choice so the device's setting applies; single-key shortcuts are a switch that
// applies at once; and an exact time in the detail panel is the viewer's zone with UTC
// beside it, in a <time> element.

const themeButton = (page: Page) => page.locator(".cap-admin-bar").getByRole("button", { name: "Dark theme" });
const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const savedTheme = (page: Page) => page.evaluate(() => localStorage.getItem("wf-theme"));

test.describe("with a light system setting", () => {
  test.use({ colorScheme: "light" });

  test("PLANT: the theme button has a fixed name and aria-pressed that follows dark", async ({ page }) => {
    await visit(page, "overview");
    await expect(themeButton(page)).toHaveAttribute("aria-pressed", "false");
    await themeButton(page).click();
    await expect(themeButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect(themeButton(page)).toHaveAccessibleName("Dark theme");
    expect(await dataTheme(page)).toBe("dark");
    // The t shortcut still switches it.
    await page.locator("main").focus();
    await page.keyboard.press("t");
    await expect(themeButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("PLANT: Display's System removes data-theme and the saved choice; Dark sets both, and the top bar follows", async ({ page }) => {
    await visit(page, "settings");
    const display = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Display" }) });
    await display.getByRole("radio", { name: /^Dark/ }).check();
    expect(await dataTheme(page)).toBe("dark");
    expect(await savedTheme(page)).toBe("dark");
    await expect(themeButton(page)).toHaveAttribute("aria-pressed", "true");
    await display.getByRole("radio", { name: /^System/ }).check();
    expect(await dataTheme(page)).toBeNull();
    expect(await savedTheme(page)).toBeNull();
    await expect(themeButton(page)).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(display.getByRole("radio", { name: /^System/ })).toBeChecked();
    await display.getByRole("radio", { name: /^Light/ }).check();
    expect(await dataTheme(page)).toBe("light");
  });
});

test("PLANT: the single-key shortcuts switch applies at once, in Display and in the shortcut sheet alike", async ({ page }) => {
  await visit(page, "settings");
  const display = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Display" }) });
  const keys = display.getByRole("switch", { name: "Single-key shortcuts" });
  await expect(keys).toHaveAttribute("aria-checked", "true");
  await keys.click();
  await expect(keys).toHaveAttribute("aria-checked", "false");
  await expect(keys).toHaveAccessibleName("Single-key shortcuts");
  // Off: g then n does nothing.
  await page.locator("main").focus();
  await page.keyboard.press("g");
  await page.keyboard.press("n");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // The sheet shows the same state, and turning it on there applies at once.
  await page.getByRole("button", { name: "Shortcuts" }).click();
  const help = page.getByRole("dialog", { name: "Keyboard" });
  const inSheet = help.getByRole("switch", { name: "Single-key shortcuts" });
  await expect(inSheet).toHaveAttribute("aria-checked", "false");
  await inSheet.click();
  await expect(inSheet).toHaveAttribute("aria-checked", "true");
  await help.getByRole("button", { name: "Close" }).click();
  await page.locator("main").focus();
  await page.keyboard.press("g");
  await page.keyboard.press("n");
  await expect(page.getByRole("heading", { level: 1, name: "Namespaces" })).toBeVisible();
});

test.describe("in a time zone behind UTC", () => {
  test.use({ timezoneId: "America/Chicago", locale: "en-US" });

  test("PLANT: an exact time in the detail panel shows the local time and UTC, in a time element", async ({ page }) => {
    await page.goto("queue/job/job_7c1e44b0a912");
    const created = page.locator("dt", { hasText: /^Created$/ }).locator("xpath=following-sibling::dd[1]");
    const time = created.locator("time");
    await expect(time).toHaveCount(1);
    const iso = await time.getAttribute("datetime");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const t = Date.parse(iso!);
    const utc = `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" }).format(t);
    // Both are on screen, not in a hover title.
    await expect(time).toContainText(utc);
    await expect(time).toContainText(local);
    await expect(time).toContainText(/C[DS]T/);
  });
});
