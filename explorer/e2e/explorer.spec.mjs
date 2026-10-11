// The explorer in a browser, both themes, desktop and phone: axe on every page, no policy
// violation, the map's one tab stop and its way inside, and the chosen system on its own page.
// The map's own keyboard and motion are Capsomer's to test (components/system-map); this checks
// the explorer wires it up.
import { expect, test } from "@playwright/test";
import { eachTheme, expectNoAxeViolations } from "capsomer/testing";

const PAGES = ["/", "/s/hub/", "/s/hub/containers/", "/s/kit/", "/s/vault/", "/s/gone/", "/nope"];

/**
 * Every console error, page error and policy violation the page raises. A failed load is one
 * too, except the 404 a test asks for.
 * @param {import("@playwright/test").Page} page @param {boolean} [expect404]
 */
async function watch(page, expect404 = false) {
  /** @type {string[]} */
  const problems = [];
  // The policy's report-uri is production's sink; nothing from a test run belongs there.
  await page.route("https://mcp.dustinedwards.info/**", (route) => route.abort());
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !(expect404 && /404 \(Not Found\)/.test(m.text()) && m.location().url.endsWith("/nope"))) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  return problems;
}

eachTheme((theme) => {
  for (const path of PAGES) {
    test(`accessibility: ${path} has no axe violation and no policy violation`, async ({ page }) => {
      const problems = await watch(page, path === "/nope");
      const res = await page.goto(path);
      expect(res?.status()).toBe(path === "/nope" ? 404 : 200);
      expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await expectNoAxeViolations(page);
      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(theme === "dark");
      expect(problems).toEqual([]);
    });
  }

  test("keyboard: the map is one tab stop, and Enter on the core twice goes inside", async ({ page }) => {
    const problems = await watch(page);
    await page.goto("/");
    const map = page.locator(".cap-system-map");
    await expect(map).toHaveAttribute("data-cap-ready", "");
    await expect(map.locator(".cap-system-map-tile[tabindex='0']")).toHaveCount(1);
    await map.locator(".cap-system-map-views button").last().focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).dataset.id)).toBe("hub");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(map).toHaveAttribute("data-entered", "");
    await page.keyboard.press("Escape");
    await expect(map).not.toHaveAttribute("data-entered", "");
    expect(problems).toEqual([]);
  });

  test("behaviour: a system's page opens with that system chosen, and its parts page inside", async ({ page }) => {
    await watch(page);
    await page.goto("/s/kit/");
    await expect(page.locator(".cap-system-map-tile[data-id='kit']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".cap-system-map-tile[data-id='kit']")).toHaveAttribute("tabindex", "0");
    await page.goto("/s/hub/containers/");
    await expect(page.locator(".cap-system-map")).toHaveAttribute("data-entered", "");
    // Entered on load without taking the reader there: the page opens at its top, focus unmoved.
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test("behaviour: nothing is wider than a phone's screen", async ({ page }) => {
    await page.goto("/s/hub/containers/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
