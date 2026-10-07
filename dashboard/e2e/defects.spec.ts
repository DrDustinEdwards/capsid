import { expect, test, type Page } from "@playwright/test";
import { ALL_VIEWS, VIEW_COUNT, visit } from "./views.ts";

// The eight defects of the UI audit's findings section 1 (capsid/research/
// audit-ui-patterns.md), each measured in the running app before it was fixed, and the
// confirm dialog ruling (DECIDE 11). One test per defect.

const drawer = (page: Page) => page.locator("dialog.drawer[open]");

// Defect 1 (DECIDE 9): the detail panel is a native modal dialog, so Tab cycles inside
// it and never reaches the page behind.
test("Tab stays inside the open panel", async ({ page }) => {
  await visit(page, "queue");
  await page.locator('main [data-open="job:job_7c1e44b0a912"]').first().click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator("[data-close]")).toBeFocused();
  const outside: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      return a.closest("dialog.drawer[open]") ? null : `${a.tagName.toLowerCase()} "${(a.textContent ?? "").trim().slice(0, 30)}"`;
    });
    if (where) outside.push(where);
  }
  expect(outside).toEqual([]);
  // Esc closes it, and the address and focus go back.
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/portal\/queue$/);
  await expect(page.locator('main [data-open="job:job_7c1e44b0a912"]').first()).toBeFocused();
});

// Defect 2: a "Holding now" row in the agent panel takes focus, and Enter opens its job.
test("Enter on a Holding now row opens the job", async ({ page }) => {
  await page.goto("./agents/agent/sample-driver");
  await expect(drawer(page)).toBeVisible();
  const held = drawer(page).locator('[data-open^="job:"]').first();
  const ref = await held.getAttribute("data-open");
  const title = (await held.locator("b").textContent()) ?? "";
  expect(ref).toMatch(/^job:job_/);
  await held.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/agents/job/${ref!.slice(4)}$`));
  await expect(drawer(page).locator("h2")).toHaveText(title);
});

// Defect 3: a namespace filter belongs to one view and lives in its address, and a list
// the filter empties says so and offers a way back.
test("a filter picked on Incidents does not change Sites, lives in the address, and an emptied list says so", async ({ page }) => {
  await visit(page, "incidents");
  await page.locator("main [role=group]").getByRole("button", { name: "watcher", exact: true }).click();
  await expect(page).toHaveURL(/\/incidents\?ns=watcher$/);
  await expect(page.locator("main [role=group]").getByRole("button", { name: "watcher", exact: true })).toHaveAttribute("aria-pressed", "true");
  // g then s: the keyboard way to another view.
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
  await expect(page).toHaveURL(/\/sites$/);
  await expect(page.locator("main [role=group]").getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("main table.fleet tbody tr[data-row]")).toHaveCount(8);
  // Reloading a filtered address keeps the filter; one that empties the list says so.
  await page.goto("./sites?ns=watcher");
  const empty = page.locator("main [data-filter-empty]");
  await expect(empty).toContainText("No site in the namespace watcher.");
  await expect(page.locator("main [role=group]").getByRole("button", { name: "watcher", exact: true })).toHaveAttribute("aria-pressed", "true");
  await empty.getByRole("button", { name: "Show all" }).click();
  await expect(page).toHaveURL(/\/sites$/);
  await expect(page.locator("main table.fleet tbody tr[data-row]")).toHaveCount(8);
});

// Defect 4: a live session stopped on a failure is critical under Needs attention, and
// the rail's Overview count includes it.
test("a critical session incident appears in Needs attention", async ({ page }) => {
  await visit(page, "overview");
  const attention = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Needs attention" }) });
  const row = attention.locator("[data-row]").filter({ hasText: "Session for agent:sample-b-driver stopped: rate_limit" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".st.crit")).toHaveCount(1);
  const crit = await attention.locator("[data-row] .st.crit").count();
  expect(crit).toBeGreaterThan(0);
  await expect(page.locator("nav.cap-admin-menu").getByRole("link", { name: `Overview, ${crit} critical` })).toHaveCount(1);
});

// Defect 5 (DECIDE 11): the perform button is named for the action, a one-way action
// focuses Cancel, and a click outside does not close the dialog.
test("the revoke confirm focuses Cancel, names its button Revoke agent, and a click outside does not close it", async ({ page }) => {
  await page.goto("./agents/agent/sample-c-driver");
  await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole("button", { name: "Revoke", exact: true }).click();
  const confirm = page.locator("dialog.confirm[open]");
  await expect(confirm.getByRole("heading", { level: 2 })).toBeVisible();
  const perform = confirm.getByRole("button", { name: "Revoke agent", exact: true });
  await expect(perform).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(confirm.getByRole("button", { name: "Do it" })).toHaveCount(0);
  // A click on the backdrop, far from the card.
  await page.mouse.click(8, 8);
  await expect(confirm).toBeVisible();
  await expect(perform).toBeVisible();
});

// Defect 5 (D11): the heading names the job by its title, before and after the preview;
// the server's summary, which carries the id, sits under it.
test("the mark-failed confirm keeps a plain heading with no job id after the preview", async ({ page }) => {
  await page.goto("./queue/job/job_7c1e44b0a912");
  await expect(drawer(page)).toBeVisible();
  await drawer(page).getByRole("button", { name: "Mark failed", exact: true }).click();
  const confirm = page.locator("dialog.confirm[open]");
  await confirm.getByLabel("Reason (required)").fill("checking the heading");
  await confirm.getByRole("button", { name: "Preview" }).click();
  await expect(confirm.getByText("What changes")).toBeVisible();
  const heading = confirm.getByRole("heading", { level: 2 });
  await expect(heading).toContainText("Mark job failed:");
  await expect(heading).not.toContainText("job_");
  await expect(confirm.locator("[data-summary]")).not.toBeEmpty();
  await confirm.getByRole("button", { name: "Cancel" }).click();
});

// Defect 6: j and k move keyboard focus itself, from the focused row.
test("j with focus on row 3 moves focus to row 4", async ({ page }) => {
  await visit(page, "queue");
  const rows = page.locator("main [data-row]");
  expect(await rows.count()).toBeGreaterThan(5);
  await rows.nth(3).focus();
  await page.keyboard.press("j");
  await expect(rows.nth(4)).toBeFocused();
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await expect(rows.nth(2)).toBeFocused();
});

// Defect 8 (SC 2.5.3): the Search button's name contains its visible word.
test("the Search button's accessible name contains Search", async ({ page }) => {
  await visit(page, "overview");
  const btn = page.locator("nav.cap-admin-strip button").filter({ hasText: "Search" });
  await expect(btn).toHaveCount(1);
  await expect(btn).toHaveAccessibleName(/^Search\b/);
  // And the command menu's input has a name.
  await btn.click();
  await expect(page.locator("dialog.palette input")).toHaveAccessibleName("Search commands");
});

// Defect 8 (SC 2.4.2): each view has its own page title, and an open panel names its
// subject in it.
test("document.title differs per view", async ({ page }) => {
  expect(ALL_VIEWS.length).toBe(VIEW_COUNT);
  const titles = new Set<string>();
  for (const v of ALL_VIEWS) {
    await visit(page, v.id);
    const t = await page.title();
    expect(t).toBe(`${v.label} · Capsid Portal`);
    titles.add(t);
  }
  expect(titles.size).toBe(VIEW_COUNT);
  await visit(page, "queue");
  const row = page.locator('main [data-open="job:job_7c1e44b0a912"]').first();
  const title = (await row.locator("b").first().textContent()) ?? "";
  await row.click();
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveTitle(`${title} · Queue · Capsid Portal`);
});
