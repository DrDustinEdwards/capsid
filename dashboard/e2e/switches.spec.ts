import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// The automation switches on Namespaces (ruled 2026-09-30, DECIDE 5, 6 and 7): a switch
// does not move until its reason is applied, a reason is required in both directions,
// Esc cancels, and an applied change leaves a message with Undo that stays until it is
// dismissed or replaced. Undo is its own action, recorded as an undo. Every test that
// changes the mock's state undoes it, so later specs read the fixture as it was.

const PREVIEW_URL = "**/portal/api/actions/preview";

const seat = (page: Page) => page.getByRole("switch", { name: "Seat start", exact: true });
const loop = (page: Page) => page.getByRole("switch", { name: "Improve loop", exact: true });
const nsSwitch = (page: Page, ns: string) => page.getByRole("switch", { name: `Improve loop for ${ns}`, exact: true });
const message = (page: Page) => page.locator(".msg-region");

async function newestActivity(page: Page): Promise<string> {
  const body = (await (await page.request.get("api/activity")).json()) as { rows: Array<{ action: string }> };
  return body.rows[0]?.action ?? "";
}

test("PLANT: flipping a switch opens a reason field and does not move it; an empty reason is an error on the field and sends nothing", async ({ page }) => {
  let sent = 0;
  await page.route(PREVIEW_URL, (route) => (sent++, route.continue()));
  await visit(page, "namespaces");
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
  await seat(page).click();
  const field = page.getByLabel("Turning seat start on. Reason:");
  await expect(field).toBeFocused();
  // Not moved: the reason has not been applied.
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const err = page.getByText("Type a reason. It is recorded with the change.");
  await expect(err).toBeVisible();
  const errId = await err.getAttribute("id");
  expect(errId).toBeTruthy();
  expect((await field.getAttribute("aria-describedby"))?.split(" ")).toContain(errId);
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
  expect(sent).toBe(0);
});

test("PLANT: Esc cancels the reason and returns focus to the switch, which has not moved", async ({ page }) => {
  await visit(page, "namespaces");
  await seat(page).click();
  const field = page.getByLabel("Turning seat start on. Reason:");
  await field.fill("typed, then thought better of it");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(seat(page)).toBeFocused();
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
});

test("PLANT: the switch's accessible name is the same in both states", async ({ page }) => {
  await visit(page, "namespaces");
  await expect(seat(page)).toHaveAccessibleName("Seat start");
  await seat(page).click();
  await page.getByLabel("Turning seat start on. Reason:").fill("checking the name");
  await page.keyboard.press("Enter");
  await expect(seat(page)).toHaveAttribute("aria-checked", "true");
  await expect(seat(page)).toHaveAccessibleName("Seat start");
  // Leave it as found.
  await message(page).getByRole("button", { name: "Undo" }).click();
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
});

test("PLANT: applying moves the switch, returns focus to it, and leaves a message with Undo that is still there after 10 seconds; Undo reverses it as its own action", async ({ page }) => {
  await page.clock.install();
  await visit(page, "namespaces");
  await seat(page).click();
  await page.getByLabel("Turning seat start on. Reason:").fill("queued jobs are waiting");
  await page.keyboard.press("Enter");
  await expect(seat(page)).toHaveAttribute("aria-checked", "true");
  await expect(seat(page)).toBeFocused();
  await expect(message(page)).toHaveAttribute("role", "status");
  await expect(message(page)).toContainText("Seat start is on.");
  expect(await newestActivity(page)).toBe("portal.seat_start");
  // It stays: no timer clears it.
  await page.clock.runFor(10_000);
  await expect(message(page)).toContainText("Seat start is on.");
  const undo = message(page).getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();

  await undo.click();
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
  await expect(seat(page)).toBeFocused();
  await expect(message(page)).toContainText("Undone.");
  await expect(message(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(await newestActivity(page)).toBe("portal.undo-seat_start");

  await message(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(message(page)).toHaveText("");
});

test("PLANT: a refusal from the Worker is shown beside the switch in plain words, and the switch does not move", async ({ page }) => {
  await page.route(PREVIEW_URL, (route) => route.fulfill({ status: 400, contentType: "text/plain", body: "seat_start needs a reason: why seat-started sessions go on or off." }));
  await visit(page, "namespaces");
  await seat(page).click();
  await page.getByLabel("Turning seat start on. Reason:").fill("anything");
  await page.keyboard.press("Enter");
  await expect(page.locator(".autoctl").getByRole("alert")).toContainText("seat_start needs a reason");
  await expect(seat(page)).toHaveAttribute("aria-checked", "false");
  await expect(message(page)).toHaveText("");
});

test("a namespace's switch reads On while running and Off when paused, with the reason beside it; there is no Pause button", async ({ page }) => {
  await visit(page, "namespaces");
  const row = page.locator("tr[data-row]").filter({ has: nsSwitch(page, "sample-d") });
  await expect(row.getByRole("button", { name: /^(Pause|Unpause)$/ })).toHaveCount(0);
  await expect(nsSwitch(page, "sample-d")).toHaveAttribute("aria-checked", "true");
  await nsSwitch(page, "sample-d").click();
  await page.getByLabel("Pausing sample-d. Reason:").fill("looking at a regression");
  await page.keyboard.press("Enter");
  await expect(nsSwitch(page, "sample-d")).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("Paused: looking at a regression");
  expect(await newestActivity(page)).toBe("portal.pause");
  await message(page).getByRole("button", { name: "Undo" }).click();
  await expect(nsSwitch(page, "sample-d")).toHaveAttribute("aria-checked", "true");
  expect(await newestActivity(page)).toBe("portal.undo-unpause");
});

test("the improve loop turns on with the chosen Runs on, and Runs on while it is on asks a reason too", async ({ page }) => {
  await visit(page, "namespaces");
  await expect(loop(page)).toHaveAttribute("aria-checked", "false");
  // While off, the choice is only held: nothing is sent.
  // The radios are drawn as a segmented control; a click lands on the label.
  await page.locator('label[for="runs-on-api"]').click();
  // Scoped by id: the overnight run has its own Runs on group with the same two names.
  await expect(page.locator("#runs-on-api")).toBeChecked();
  await loop(page).click();
  await page.getByLabel("Turning the improve loop on, on API. Reason:").fill("try the API run");
  await page.keyboard.press("Enter");
  await expect(loop(page)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Running on API.")).toBeVisible();

  // A change of Runs on while the loop is on is a change of mode: a reason first.
  await page.locator('label[for="runs-on-subscription"]').click();
  const field = page.getByLabel("Changing the improve loop to run on Subscription. Reason:");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(page.locator("#runs-on-api")).toBeChecked();

  // Leave it as found: off.
  await loop(page).click();
  await page.getByLabel("Turning the improve loop off. Reason:").fill("leave the fixture as it was");
  await page.keyboard.press("Enter");
  await expect(loop(page)).toHaveAttribute("aria-checked", "false");
});

test("Queue and Agents show the state as a word that links to Namespaces, with no control of their own", async ({ page }) => {
  await visit(page, "queue");
  await expect(page.getByRole("button", { name: /^Turn (on|off)$/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Change it in Namespaces" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Namespaces" })).toBeVisible();
  await visit(page, "agents");
  await expect(page.getByRole("button", { name: /^(Switch to|Turn off)/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Change it in Namespaces" })).toBeVisible();
});

// The overnight run's switch (docs/overnight.md): the same pattern with its own "Runs on"
// choice. Choosing the subscription records Dustin's decision with the switch, and the
// panel shows it. Undone at the end, so later specs read the fixture as it was.

const overnight = (page: Page) => page.getByRole("switch", { name: "Overnight run", exact: true });

test("PLANT: the overnight run is off and runs on the API key by default, and turning it on asks a reason before it moves", async ({ page }) => {
  await visit(page, "namespaces");
  await expect(overnight(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#overnight-runs-on-api")).toBeChecked();
  await expect(page.locator("#overnight-runs-on-subscription")).not.toBeChecked();
  await overnight(page).click();
  const field = page.getByLabel("Turning the overnight run on, on API. Reason:");
  await expect(field).toBeFocused();
  await expect(overnight(page)).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(overnight(page)).toBeFocused();
});

test("PLANT: choosing the subscription records Dustin's decision, its date and its reasoning where the switch is set, and the panel shows it", async ({ page }) => {
  await visit(page, "namespaces");
  await expect(page.locator("#overnight-decision")).toHaveCount(0);
  // The radios are drawn as a segmented control; a click lands on the label.
  await page.locator('label[for="overnight-runs-on-subscription"]').click();
  await overnight(page).click();
  await page.getByLabel("Turning the overnight run on, on Subscription. Reason:").fill("first supervised night");
  await page.keyboard.press("Enter");
  await expect(overnight(page)).toHaveAttribute("aria-checked", "true");
  await expect(message(page)).toContainText("The overnight run is now subscription.");
  const decision = page.locator("#overnight-decision");
  await expect(decision).toContainText("Decision recorded: Sample Person, 2026-10-04.");
  await expect(decision).toContainText("overnight runs may use the subscription, by the owner's choice");
  await expect(decision).toContainText("first supervised night");
  expect(await newestActivity(page)).toBe("portal.overnight");

  // Leave it as found.
  await message(page).getByRole("button", { name: "Undo" }).click();
  await expect(overnight(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#overnight-decision")).toHaveCount(0);
  expect(await newestActivity(page)).toBe("portal.undo-overnight");
});
