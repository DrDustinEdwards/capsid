import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// Every stop in the command menu (capsid/decisions.md 2026-09-30, "admin panels review
// adopted", item 4; job_fe0da37c07e0 PR 4). A stop runs the control it stands for: a
// switch's reason field in Settings' automation section, or the confirm dialog. Nothing here performs a
// change, so the mock's state is left as found.

async function menu(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const dlg = page.getByRole("dialog", { name: "Command menu" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("combobox").fill(query);
  return dlg;
}

// Rewrites the feed on its way to the app, so a switch reads as on without the mock's
// state changing.
async function reshape(page: Page, fn: (f: OpsFeed) => void): Promise<void> {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    fn(feed);
    await route.fulfill({ response: res, json: feed });
  });
}

test("PLANT: typing stop lists the stops, and only for what is running", async ({ page }) => {
  await visit(page, "health");
  const dlg = await menu(page, "stop");
  const stops = dlg.getByRole("option").filter({ hasText: /^S\s*Stop/ });
  // The overnight run is off in the sample feed, and the revoked agent is revoked.
  await expect(stops.filter({ hasText: "Turn the overnight run off" })).toHaveCount(0);
  await expect(stops.filter({ hasText: /Revoke/ }).first()).toBeVisible();
  await expect(dlg.getByRole("option").filter({ hasText: /all/i }).filter({ hasText: /Stop/ })).toHaveCount(0);
});

test("PLANT: Turn the overnight run off from the menu opens that switch's reason in Settings, and moves nothing", async ({ page }) => {
  await reshape(page, (f) => void (f.live.overnight.mode = "api"));
  await visit(page, "health");
  const dlg = await menu(page, "overnight run off");
  await dlg.getByRole("option").filter({ hasText: "Turn the overnight run off" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const field = page.getByLabel("Turning the overnight run off. Reason:");
  await expect(field).toBeFocused();
  const sw = page.getByRole("switch", { name: "Overnight run", exact: true });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(sw).toHaveAttribute("aria-checked", "true");
});

test("Revoke from the menu opens the confirm dialog, which previews before anything is done", async ({ page }) => {
  await visit(page, "health");
  const dlg = await menu(page, "revoke");
  const first = dlg.getByRole("option").filter({ hasText: /Stop\s*Revoke / }).first();
  const name = ((await first.innerText()).match(/Revoke (\S+)/) ?? [])[1];
  expect(name, "a Revoke stop names its agent").toBeTruthy();
  await first.click();
  const confirm = page.getByRole("dialog", { name: `Revoke agent ${name}` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
});
