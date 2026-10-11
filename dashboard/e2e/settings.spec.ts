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
    tile: await page.locator(".tiles .tile").filter({ hasText: "Sites up" }).count(),
    // Health's Sites section, with its one row per site (audit ruling 1).
    section: await page.getByRole("heading", { level: 2, name: "Sites", exact: true }).count(),
    fleet: await page.locator("main table.fleet").count(),
  };
}

// The site rows among Needs you's problems (the attention list moved there from the
// Overview, design-portal-evaluation.md DECIDE 1).
async function siteProblems(page: Page): Promise<number> {
  await visit(page, "needs");
  return page.locator(".att-row .kind").filter({ hasText: /^Site$/ }).count();
}

test("with sites configured, Health shows its site items", async ({ page }) => {
  await visit(page, "health");
  const seen = await siteItems(page);
  // The other test's counts of zero mean something only if these are not zero.
  expect(seen).toEqual({ tile: 1, section: 1, fleet: 1 });
  expect(await siteProblems(page)).toBeGreaterThan(0);
});

test("with no site configured, Health has no Sites section and shows no site items", async ({ page }) => {
  await withoutSites(page);
  await visit(page, "health");
  expect(await siteItems(page)).toEqual({ tile: 0, section: 0, fleet: 0 });
  await expect(page.locator("nav.cap-admin-menu a")).toHaveCount(RAIL_COUNT);
  // Settings stays reachable: under the avatar, where the first site is added.
  await page.getByRole("button", { name: "Your account" }).click();
  await expect(page.locator(".cap-admin-account").getByRole("link", { name: "Portal settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Everything else is still there.
  await expect(page.locator(".tiles .tile").filter({ hasText: "Blocked on you" })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: "Incidents", exact: true })).toHaveCount(1);

  // The command menu offers no site.
  await page.keyboard.press("Control+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  // A site command reads "Site <name>  <host>"; the sample hosts are sample-*.example.com.
  await menu.getByRole("combobox").fill("sample-a.example.com");
  await expect(menu.getByRole("option").filter({ hasText: "sample-a.example.com" })).toHaveCount(0);
  await menu.getByRole("combobox").fill("settings");
  await expect(menu.getByRole("option").filter({ hasText: /Go to\s*Settings/ })).toHaveCount(1);
  await page.keyboard.press("Escape");

  // The old Sites address lands on Health, which has no Sites section to show.
  await page.goto("sites");
  await expect(page.getByRole("heading", { level: 1, name: "Health" })).toBeVisible();
  await expect(page.locator("#sites")).toHaveCount(0);

  // Settings says why, and is where the first site is added.
  await visit(page, "settings");
  await expect(page.locator("main")).toContainText("No site is configured");
});

test.describe("on a phone, with no site configured", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the tabs are the same, and Settings is under More", async ({ page }) => {
    await withoutSites(page);
    await visit(page, "health");
    const tabs = page.locator("nav.cap-admin-tabs > a, nav.cap-admin-tabs > button");
    await expect(tabs).toHaveText([/^Needs you/, /^Queue/, /^Health/, /^More$/]);
    await page.locator("nav.cap-admin-tabs").getByRole("button", { name: "More" }).tap();
    await expect(page.getByRole("dialog").getByRole("link", { name: /^Portal settings/ })).toBeVisible();
  });
});

// Phone alerts (src/push.ts): the panel loads on its own after Settings, lists the
// devices with alerts on, sends a test and turns a device off. The mock never sends.
test.describe.serial("phone alerts", () => {
  test("the panel lists the device, sends a test and turns the device off", async ({ page }) => {
    await visit(page, "settings");
    const panel = page.locator("section.cap-panel", { has: page.getByRole("heading", { name: "Phone alerts" }) });
    await expect(panel).toContainText("Chrome on Android");
    await expect(panel).toContainText("it has no Approve button");
    await panel.getByRole("button", { name: "Send a test alert", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Test alert sent to each device.");
    await panel.getByRole("button", { name: "Turn off", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Alerts are off for Chrome on Android.");
    await expect(panel).not.toContainText("turned on");
    await expect(panel.getByRole("button", { name: "Send a test alert", exact: true })).toBeDisabled();
  });
});
