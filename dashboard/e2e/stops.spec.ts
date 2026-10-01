import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// Every stop in the command menu (capsid/decisions.md 2026-09-30, "admin panels review
// adopted", item 4; job_fe0da37c07e0 PR 4). A stop runs the control it stands for: a
// switch's reason field on Namespaces, or the confirm dialog. Nothing here performs a
// change, so the mock's state is left as found.

async function menu(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const dlg = page.getByRole("dialog", { name: "Command menu" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("combobox").fill(query);
  return dlg;
}

test("PLANT: typing stop lists the stops, and only for what is running", async ({ page }) => {
  await visit(page, "overview");
  const dlg = await menu(page, "stop");
  const stops = dlg.getByRole("option").filter({ hasText: /^S\s*Stop/ });
  await expect(stops.filter({ hasText: "Pause sample-b" })).toHaveCount(1);
  // sample-c is paused in the sample feed, and the revoked agent is revoked.
  await expect(stops.filter({ hasText: "Pause sample-c" })).toHaveCount(0);
  await expect(stops.filter({ hasText: /Revoke/ }).first()).toBeVisible();
  await expect(dlg.getByRole("option").filter({ hasText: /all/i }).filter({ hasText: /Stop/ })).toHaveCount(0);
});

test("PLANT: Pause from the menu opens that switch's reason on Namespaces, and moves nothing", async ({ page }) => {
  await visit(page, "overview");
  const dlg = await menu(page, "pause sample-b");
  await dlg.getByRole("option").filter({ hasText: "Pause sample-b" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Namespaces" })).toBeVisible();
  const field = page.getByLabel("Pausing sample-b. Reason:");
  await expect(field).toBeFocused();
  const sw = page.getByRole("switch", { name: "Improve loop for sample-b", exact: true });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(sw).toHaveAttribute("aria-checked", "true");
});

test("Revoke from the menu opens the confirm dialog, which previews before anything is done", async ({ page }) => {
  await visit(page, "overview");
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
