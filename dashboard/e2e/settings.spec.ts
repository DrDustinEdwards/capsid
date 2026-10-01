import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { RAIL_COUNT, visit } from "./views.ts";

// The Settings view: the site configuration, edited through the confirm dialog, against
// the production build and the dev mock (dev/mock-api.ts), which keeps changes in memory
// for the life of the preview server. The first four tests run in order on one namespace
// the mock has registered with no row (sample-i), and leave the configuration as they
// found it.

const NS = "sample-i";
const row = (page: Page, ns = NS) => page.locator("main tr[data-row]").filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${ns}$`) }) });

async function openAdd(page: Page) {
  await visit(page, "settings");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Add a site" })).toBeVisible();
}

test.describe.serial("the site configuration", () => {
  test("add a site through the form: preview, Add site, and the row appears", async ({ page }) => {
    await openAdd(page);
    await expect(row(page)).toHaveCount(0);
    await page.getByLabel("Namespace", { exact: true }).fill(NS);
    await page.getByLabel("Name", { exact: true }).fill("Sample I");
    await page.getByLabel("Origin", { exact: true }).fill("https://sample-i.example.com");
    await page.getByLabel("Health path", { exact: true }).fill("/health");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("What changes")).toBeVisible();
    await expect(dialog).toContainText("ops_sites: add sample-i");
    await dialog.getByRole("button", { name: "Add site", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(row(page)).toHaveCount(1);
    await expect(row(page)).toContainText("https://sample-i.example.com");
    await expect(row(page)).toContainText("/health");
    // The form closed once the change was made.
    await expect(page.getByRole("heading", { level: 2, name: "Add a site" })).toHaveCount(0);
  });

  test("edit a row: the form opens filled in, and the change shows with a new revision", async ({ page }) => {
    await visit(page, "settings");
    await row(page).getByRole("button", { name: `Edit ${NS}` }).click();
    await expect(page.getByRole("heading", { level: 2, name: `Edit ${NS}` })).toBeVisible();
    await expect(page.getByLabel("Origin", { exact: true })).toHaveValue("https://sample-i.example.com");
    await page.getByLabel("Name", { exact: true }).fill("Sample I renamed");
    await page.getByLabel("Platform", { exact: true }).selectOption("vercel");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText('name: "Sample I" -> "Sample I renamed"');
    await expect(dialog).toContainText("revision 1 -> 2");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(row(page)).toContainText("Sample I renamed");
    await expect(row(page)).toContainText("Vercel");
    await expect(row(page).locator('td[data-label="Revision"] .num')).toHaveText("2");
  });

  test("a refusal from the server is shown in the dialog, verbatim", async ({ page }) => {
    await openAdd(page);
    await page.getByLabel("Namespace", { exact: true }).fill("sample-j");
    await page.getByLabel("Origin", { exact: true }).fill("http://sample-j.example.com");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("alert")).toHaveText("the origin must start with https://; got 'http://sample-j.example.com'.");
    await expect(dialog.getByRole("button", { name: "Add site", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // Cancel keeps what was typed.
    await expect(page.getByLabel("Origin", { exact: true })).toHaveValue("http://sample-j.example.com");
  });

  test("remove a row", async ({ page }) => {
    await visit(page, "settings");
    await row(page).getByRole("button", { name: `Remove ${NS}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`ops_sites: remove ${NS}`);
    await dialog.getByRole("button", { name: "Remove site", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(row(page)).toHaveCount(0);
  });
});

test("a row that serves no site is listed as such, and a blank origin is caught before sending", async ({ page }) => {
  await visit(page, "settings");
  await expect(row(page, "sample-docs")).toContainText("Serves no site");
  let sent = 0;
  await page.route("**/portal/api/actions/preview", (route) => (sent++, route.continue()));
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await page.getByLabel("Namespace", { exact: true }).fill(NS);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Give the site's origin");
  expect(sent).toBe(0);
  // Ticking "Serves no site" turns the site's fields off.
  await page.getByLabel("Serves no site").check();
  for (const label of ["Origin", "Health path", "Platform", "Worker script"]) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
});

// ---- no site configured ---------------------------------------------------------------

// The feed with no row that has an origin. The snapshot's sites are left in, so what
// hides them is the configuration, not an empty watcher pass.
async function withoutSites(page: Page) {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.sites = feed.live.sites.filter((s) => s.origin === null);
    await route.fulfill({ response: res, json: feed });
  });
}

async function siteItems(page: Page) {
  return {
    rail: await page.locator("nav.rail a").filter({ hasText: /^Sites/ }).count(),
    tile: await page.locator(".tiles .tile").filter({ hasText: "Sites up" }).count(),
    // The Overview's one row per site (audit ruling 1).
    fleet: await page.getByRole("heading", { level: 2, name: "Sites", exact: true }).count(),
    timeline: await page.getByRole("heading", { level: 2, name: "Deploys and downtime, 7 days" }).count(),
    attention: await page.locator(".att-row .kind").filter({ hasText: /^Site$/ }).count(),
  };
}

test("with sites configured, the Overview shows its site items", async ({ page }) => {
  await visit(page, "overview");
  const seen = await siteItems(page);
  // The other test's counts of zero mean something only if these are not zero.
  expect(seen.rail).toBe(1);
  expect(seen.tile).toBe(1);
  expect(seen.fleet).toBe(1);
  expect(seen.timeline).toBe(1);
  expect(seen.attention).toBeGreaterThan(0);
});

test("with no site configured, there is no Sites view and the Overview shows no site items", async ({ page }) => {
  await withoutSites(page);
  await visit(page, "overview");
  expect(await siteItems(page)).toEqual({ rail: 0, tile: 0, fleet: 0, timeline: 0, attention: 0 });
  await expect(page.locator("nav.rail a")).toHaveCount(RAIL_COUNT - 1);
  // Settings stays reachable: the top bar's button, where the first site is added.
  await expect(page.locator("header.top").getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  // Everything else is still there.
  await expect(page.getByRole("heading", { level: 2, name: "Needs attention" })).toBeVisible();
  await expect(page.locator(".tiles .tile").filter({ hasText: "Blocked on you" })).toHaveCount(1);

  // The command menu offers no Sites view and no site.
  await page.keyboard.press("Control+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  await menu.getByRole("combobox").fill("sites");
  await expect(menu.getByRole("option").filter({ hasText: /Go to\s*Sites/ })).toHaveCount(0);
  // A site command reads "Site <name>  <host>"; the sample hosts are sample-*.example.com.
  await menu.getByRole("combobox").fill("sample-a.example.com");
  await expect(menu.getByRole("option").filter({ hasText: "sample-a.example.com" })).toHaveCount(0);
  await menu.getByRole("combobox").fill("settings");
  await expect(menu.getByRole("option").filter({ hasText: /Go to\s*Settings/ })).toHaveCount(1);
  await page.keyboard.press("Escape");

  // The Sites address lands on the Overview.
  await page.goto("sites");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/sites$/);
  // And its shortcut does nothing.
  await page.locator("main").focus();
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  // Settings says why, and is where the first site is added.
  await visit(page, "settings");
  await expect(page.locator("main")).toContainText("No site is configured");
});

test.describe("on a phone, with no site configured", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("there is no Sites tab, and Settings is under More", async ({ page }) => {
    await withoutSites(page);
    await visit(page, "overview");
    const tabs = page.locator("nav.tabbar > a, nav.tabbar > button");
    await expect(tabs).toHaveText([/^Overview/, /^Queue/, /^Incidents/, /^More$/]);
    await page.locator("nav.tabbar").getByRole("button", { name: "More" }).tap();
    await expect(page.getByRole("dialog").getByRole("link", { name: /^Settings/ })).toBeVisible();
  });
});
