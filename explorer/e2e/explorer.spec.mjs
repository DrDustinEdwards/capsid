// The explorer in a browser, both themes, desktop and phone: axe on every page, no policy
// violation, the map's one tab stop and its way inside, and the chosen system on its own page.
// The map's own keyboard and motion are Capsomer's to test (components/system-map); this checks
// the explorer wires it up.
import { expect, test } from "@playwright/test";
import { eachTheme, expectNoAxeViolations } from "capsomer/testing";

const PAGES = ["/", "/s/hub/", "/s/hub/containers/", "/s/kit/", "/s/theme/code/", "/s/theme/code/src/index.ts/", "/s/vault/", "/s/gone/", "/flows/sample-round/", "/flows/sample-round/1/", "/flows/sample-round/2/", "/nope"];

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

/**
 * Counts each animation started on the map's token: a finished one leaves getAnimations(), so
 * the count is what says the token travelled.
 * @param {import("@playwright/test").Page} page
 */
async function countTokenMoves(page) {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.tokenMoves = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      if (this.classList.contains("cap-system-map-token")) w.tokenMoves++;
      return animate.apply(this, args);
    };
  });
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
    for (const path of ["/s/hub/containers/", "/", "/flows/sample-round/2/"]) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
    }
  });

  test("flow: number keys and Next step the flow in place, the address follows, and a token travels the line", async ({ page }) => {
    const problems = await watch(page);
    await countTokenMoves(page);
    await page.goto("/flows/sample-round/1/");
    const map = page.locator(".cap-system-map");
    await expect(map).toHaveAttribute("data-flow", "sample-round");
    await expect(map).toHaveAttribute("data-step", "1");
    await expect(page.locator("[data-keys]")).toBeVisible();
    const loads = await page.evaluate(() => performance.getEntriesByType("navigation").length);

    await page.keyboard.press("3");
    await expect(page).toHaveURL(/\/flows\/sample-round\/3\/$/);
    await expect(page.locator("#step-title")).toHaveText("Step 3 of 3");
    await expect(map).toHaveAttribute("data-step", "3");
    await expect(page.locator(".cap-system-map-wire[data-on]")).toHaveAttribute("data-from", "hub-tick");
    await expect(page.locator(".flow-touches li")).toHaveCount(2);
    await expect(page.locator(".flow-nav a[rel='next']")).toHaveCount(0);

    await page.locator(".flow-nav a[rel='prev']").click();
    await expect(page).toHaveURL(/\/flows\/sample-round\/2\/$/);
    await expect(page.locator("#step-title")).toHaveText("Step 2 of 3");
    // Focus stays on Back, now step 2's own Back.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("rel"))).toBe("prev");
    // The token moved for the load, for 3 and for Back: one animation each.
    expect(await page.evaluate(() => /** @type {any} */ (window).tokenMoves)).toBe(3);

    await page.goBack();
    await expect(page.locator("#step-title")).toHaveText("Step 3 of 3");
    await expect(map).toHaveAttribute("data-step", "3");
    // Every step happened in the one page.
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(loads);
    expect(problems).toEqual([]);
  });

  test("flow: under reduced motion a step jumps, with no animation running", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const problems = await watch(page);
    await countTokenMoves(page);
    await page.goto("/flows/sample-round/1/");
    await expect(page.locator(".cap-system-map")).toHaveAttribute("data-step", "1");
    await page.keyboard.press("2");
    await expect(page.locator("#step-title")).toHaveText("Step 2 of 3");
    await expect(page.locator(".cap-system-map-token")).toBeVisible();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.locator(".flow-nav a[rel='next']").click();
    await expect(page.locator("#step-title")).toHaveText("Step 3 of 3");
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).tokenMoves)).toBe(0);
    expect(problems).toEqual([]);
  });

  test("flow: with no script every step is its own page, drawn at its step", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: theme });
    const page = await context.newPage();
    await page.goto("/flows/sample-round/1/");
    await expect(page.locator(".cap-system-map")).toHaveAttribute("data-entered", "");
    await expect(page.locator(".cap-system-map-wire[data-on]")).toHaveCount(1);
    await page.locator(".flow-nav a[rel='next']").click();
    await expect(page).toHaveURL(/\/flows\/sample-round\/2\/$/);
    await expect(page.locator("#step-title")).toHaveText("Step 2 of 3");
    await expect(page.locator(".cap-system-map-box[data-at]")).toHaveAttribute("data-id", "hub-db");
    await context.close();
  });
});
