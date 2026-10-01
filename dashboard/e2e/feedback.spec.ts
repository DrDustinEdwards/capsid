import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// Warnings and failures stay on screen until dismissed (capsid/decisions.md 2026-09-30,
// "admin panels review adopted", item 3; job_fe0da37c07e0 PR 3). Every test that
// changes the mock's state puts it back, so later specs read the fixture as it was.

const REFRESH_URL = "**/portal/api/ops/refresh";
const PERFORM_URL = "**/portal/api/actions/perform";
const AUDIT_WARNING = "the Portal audit row naming access:admin@example.com was not written: D1 is unavailable";

const message = (page: Page) => page.locator(".msg-region");
const seat = (page: Page) => page.getByRole("switch", { name: "Seat start", exact: true });

async function flipSeat(page: Page, reason: string): Promise<void> {
  await seat(page).click();
  await page.getByLabel(/^Turning seat start (on|off)\. Reason:$/).fill(reason);
  await page.keyboard.press("Enter");
}

test("PLANT: a failed refresh says why, from the Worker's own text, and stays until dismissed", async ({ page }) => {
  await page.clock.install();
  await page.route(REFRESH_URL, (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "the watcher pass failed: GitHub answered 502" }));
  await visit(page, "overview");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const failed = message(page).locator(".msg").filter({ hasText: "Refresh failed" });
  await expect(failed).toHaveText(/Refresh failed: the watcher pass failed: GitHub answered 502 \(HTTP 500\)/);
  await expect(failed.getByRole("alert")).toBeVisible();
  await page.clock.runFor(30_000);
  await expect(failed).toBeVisible();
  await failed.getByRole("button", { name: "Dismiss" }).click();
  await expect(message(page)).toHaveText("");
});

test("PLANT: a refresh whose audit row was not written shows the warning, and it stays", async ({ page }) => {
  await page.clock.install();
  await page.route(REFRESH_URL, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "x-capsid-warning": AUDIT_WARNING } });
  });
  await visit(page, "overview");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(message(page)).toContainText(`Warning: ${AUDIT_WARNING}`);
  await page.clock.runFor(30_000);
  await expect(message(page)).toContainText(`Warning: ${AUDIT_WARNING}`);
});

test("PLANT: an action's audit warning stays through the next action and its Undo, until dismissed", async ({ page }) => {
  let warnOnce = true;
  await page.route(PERFORM_URL, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { warning: string | null };
    if (warnOnce) (body.warning = AUDIT_WARNING), (warnOnce = false);
    await route.fulfill({ response: res, json: body });
  });
  await visit(page, "namespaces");
  await flipSeat(page, "queued jobs are waiting");
  await expect(seat(page)).toHaveAttribute("aria-checked", "true");
  const warned = message(page).locator(".msg").filter({ hasText: AUDIT_WARNING });
  await expect(warned).toContainText("Seat start is on.");

  // The next action replaces nothing that carries a warning.
  await flipSeat(page, "back as it was");
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
  await expect(message(page).locator(".msg")).toHaveCount(2);
  await expect(message(page).locator(".msg").first()).toContainText("Seat start is off.");
  await expect(warned).toBeVisible();

  await warned.getByRole("button", { name: "Dismiss" }).click();
  await expect(warned).toHaveCount(0);
  await expect(message(page).locator(".msg")).toHaveCount(1);
});
