// The explorer in a browser, both themes, desktop and phone: axe on every page, no policy
// violation, the map's one tab stop and its way inside, and the chosen system on its own page.
// The map's own keyboard and motion are Capsomer's to test (components/system-map); this checks
// the explorer wires it up.
import { expect, test } from "@playwright/test";
import { eachTheme, expectNoAxeViolations } from "capsomer/testing";

const PAGES = ["/", "/systems/", "/flows/", "/tools/", "/tools/capsid_work_jobs/", "/numbers/", "/code/", "/search/", "/s/hub/", "/s/hub/containers/", "/s/kit/", "/s/theme/code/", "/s/vault/", "/s/gone/", "/flows/sample-round/", "/flows/sample-round/1/", "/flows/sample-round/2/", "/nope"];

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
    // Enforced violations only: the staged Report-Only policy (Trusted Types, from the registry)
    // reports Capsomer's DOM sinks by design, and those reports are what it is staged to collect.
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.disposition === "enforce") console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`);
    });
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

  test("keyboard: focusing a system lights what it uses and what uses it, and Enter opens it", async ({ page }) => {
    const problems = await watch(page);
    await page.goto("/systems/");
    const map = page.locator(".cap-system-map");
    await expect(map).toHaveAttribute("data-cap-ready", "");
    await map.getByRole("link", { name: "Kit", exact: true }).focus();
    await expect(map).toHaveAttribute("data-lit", "kit");
    await expect(map.locator(".cap-system-map-card[data-id='hub']")).toHaveAttribute("data-tie", /.+/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\/kit\/$/);
    await expect(page.locator(".cap-system-map")).toHaveAttribute("data-system", "kit");
    await expect(page.locator("[data-column='used-by'] .cap-system-map-tie[data-id='hub']")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("behavior: nothing is wider than a phone's screen", async ({ page }) => {
    for (const path of ["/s/hub/containers/", "/", "/systems/", "/tools/", "/numbers/", "/code/", "/flows/sample-round/2/"]) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
    }
  });

  test("flow: number keys and Next step the flow in place, the address follows, and the step's parts light", async ({ page }) => {
    const problems = await watch(page);
    await page.goto("/flows/sample-round/1/");
    const map = page.locator(".cap-system-map");
    await expect(map).toHaveAttribute("data-flow", "sample-round");
    await expect(map).toHaveAttribute("data-step", "1");
    // The script reveals the hint; on a touch screen the stylesheet keeps it out of sight.
    await expect(page.locator("[data-keys]")).not.toHaveAttribute("hidden");
    const loads = await page.evaluate(() => performance.getEntriesByType("navigation").length);

    await page.keyboard.press("3");
    await expect(page).toHaveURL(/\/flows\/sample-round\/3\/$/);
    await expect(page.locator("#step-title")).toHaveText("Step 3 of 3");
    await expect(map).toHaveAttribute("data-step", "3");
    await expect(map.locator(".cap-system-map-part[data-id='hub-tick']")).toHaveAttribute("data-lit", "");
    await expect(page.locator(".flow-touches li[data-part]")).toHaveCount(2);
    await expect(page.locator(".flow-nav a[rel='next']")).toHaveCount(0);

    await page.locator(".flow-nav a[rel='prev']").click();
    await expect(page).toHaveURL(/\/flows\/sample-round\/2\/$/);
    await expect(page.locator("#step-title")).toHaveText("Step 2 of 3");
    // Focus stays on Back, now step 2's own Back.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("rel"))).toBe("prev");

    await page.goBack();
    await expect(page.locator("#step-title")).toHaveText("Step 3 of 3");
    await expect(map).toHaveAttribute("data-step", "3");
    // Every step happened in the one page.
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(loads);
    expect(problems).toEqual([]);
  });

  // Animations that run over time. The letterhead's fade follows the scroll position, not the
  // clock, so it stays listed as running and moves nothing when a step changes.
  const timedAnimations = () =>
    document.getAnimations().filter((a) => a.timeline instanceof DocumentTimeline).length;

  test("flow: under reduced motion a step jumps, with no animation running", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const problems = await watch(page);
    await page.goto("/flows/sample-round/1/");
    await expect(page.locator(".cap-system-map")).toHaveAttribute("data-step", "1");
    await page.keyboard.press("2");
    await expect(page.locator("#step-title")).toHaveText("Step 2 of 3");
    expect(await page.evaluate(timedAnimations)).toBe(0);
    await page.locator(".flow-nav a[rel='next']").click();
    await expect(page.locator("#step-title")).toHaveText("Step 3 of 3");
    expect(await page.evaluate(timedAnimations)).toBe(0);
    expect(problems).toEqual([]);
  });

  test("flow: with no script every step is its own page, drawn at its step", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: theme });
    const page = await context.newPage();
    await page.goto("/flows/sample-round/1/");
    await expect(page.locator(".cap-system-map")).toHaveAttribute("data-step", "1");
    await expect(page.locator(".cap-system-map-part[data-lit]").first()).toBeVisible();
    await page.locator(".flow-nav a[rel='next']").click();
    await expect(page).toHaveURL(/\/flows\/sample-round\/2\/$/);
    await expect(page.locator("#step-title")).toHaveText("Step 2 of 3");
    await expect(page.locator(".cap-system-map-part[data-at]")).toHaveAttribute("data-id", "hub-db");
    await context.close();
  });
});
