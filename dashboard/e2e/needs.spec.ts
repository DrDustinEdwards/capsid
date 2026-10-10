import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// Needs you, the home (docs/design/design-portal-evaluation.md DECIDE 1, ruled 2026-10-09):
// the per-app inbox from the gatherer GET /ops/inbox answers with, then the attention list
// that moved here from the Overview.

async function reshape(page: Page, fn: (f: OpsFeed) => void): Promise<void> {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    fn(feed);
    await route.fulfill({ response: res, json: feed });
  });
}

const byApp = (page: Page) => page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "By app" }) });

test("PLANT: the home address is Needs you, with each app that has something waiting, worst first, and the quiet ones named", async ({ page }) => {
  // The failing app first in the configuration, so the order on the page is the page's.
  await reshape(page, (f) => {
    const failing = f.live.inbox.apps.filter((a) => a.severity === "failing");
    f.live.inbox.apps = [...failing, ...f.live.inbox.apps.filter((a) => a.severity !== "failing")];
  });
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Needs you" })).toBeVisible();
  const apps = byApp(page).locator(".inbox-app h3");
  // The sample inbox: three apps need you, one is failing, five are quiet.
  await expect(apps).toHaveCount(4);
  const names = await apps.allInnerTexts();
  expect(names.at(-1), "the app with only a machine fault comes after the ones that need a person").toMatch(/^Sample F\b.*failing/);
  await expect(byApp(page).getByText(/^Nothing waiting: /)).toContainText("Sample D");
  // An item with a link opens it; one without is plain text.
  await expect(byApp(page).getByRole("link", { name: /PR #32 waits for the seat/ })).toHaveAttribute("href", "https://github.com/example-org/sample-c/pull/32");
  // The rail's count is the inbox's count, the number the admin strip's badge shows.
  await expect(page.locator("nav.cap-admin-menu").getByRole("link", { name: "Needs you, 6 waiting on you" })).toHaveCount(1);
  // The attention list is here too, under the inbox.
  await expect(page.getByRole("heading", { level: 2, name: "Needs attention" })).toBeVisible();
});

test("with nothing waiting it says so, and every app is named as quiet", async ({ page }) => {
  await reshape(page, (f) => {
    f.live.inbox = { ...f.live.inbox, count: 0, severity: "none", apps: f.live.inbox.apps.map((a) => ({ ...a, count: 0, severity: "none", items: [] })) };
  });
  await visit(page, "needs");
  await expect(byApp(page).getByText("Nothing needs you.")).toBeVisible();
  await expect(byApp(page).locator(".inbox-app")).toHaveCount(0);
  await expect(byApp(page).getByText(/^Nothing waiting: /)).toContainText("Sample A");
});
