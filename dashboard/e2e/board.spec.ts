import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

const waiting = (page: Page) => page.locator("#waiting");
const quiet = (page: Page) =>
  page.context().addCookies([{ name: "wf-mock", value: "quiet", url: "http://localhost:4174/" }]);

test("PLANT: the home is the Board, and what waits on you comes first", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Board" })).toBeVisible();
  // Two handoff asks and the inbox's two items.
  await expect(waiting(page).locator(".cap-row")).toHaveCount(4);
  const order = await page.evaluate(() =>
    ["#waiting", "#attention", "#pr-trouble", "#handoffs", "#threads"].map(
      (s) => document.querySelector(s)!.getBoundingClientRect().top,
    ),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  await expect(
    page.locator("nav.cap-admin-menu").getByRole("link", { name: /^Board/ }),
  ).toHaveAccessibleName("Board");
  await expect(page.getByRole("heading", { level: 2, name: "Problems" })).toBeVisible();
  await expect(
    page.locator("#attention").getByText(/await the seat|merge it or say why/),
  ).toHaveCount(0);
});

test("a handoff's ask links to it in Memory", async ({ page }) => {
  await page.goto("./");
  await waiting(page)
    .getByRole("link", { name: /Pick the card width/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
  await expect(page).toHaveURL(/memory\?doc=sample%2Fhandoff%2Fportal-layout\.md/);
});

test("the open handoffs, the threads and the pull request trouble are drawn", async ({ page }) => {
  await page.goto("./");
  const handoffs = page
    .locator("#handoffs")
    .getByRole("table", { name: "Data for: Open handoffs" });
  await expect(handoffs).toBeVisible();
  // Sorted by open items: the layout pass (4 open) first, its title a link to the handoff.
  await expect(handoffs.locator("tbody th").first()).toHaveText("Portal layout pass");
  await expect(handoffs.getByRole("link", { name: "Portal layout pass" })).toHaveAttribute(
    "href",
    /\/memory\?doc=sample%2Fhandoff%2Fportal-layout\.md$/,
  );
  await expect(handoffs.getByText("no checklist")).toBeVisible();
  await expect(page.locator("#threads svg[role='img']")).toHaveCount(1);
  await expect(
    page
      .locator("#threads")
      .getByRole("table", { name: "Data for: Recent threads" })
      .locator("tbody tr"),
  ).toHaveCount(10);
  const trouble = page.locator("#pr-trouble");
  await expect(trouble.getByText("CI red")).toBeVisible();
  await expect(trouble.getByText("Conflict")).toBeVisible();
  await expect(trouble.getByText("Same files")).toBeVisible();
  await expect(trouble.getByText(/as of/)).toBeVisible();
});

test("PLANT: the list does not move once the page has loaded", async ({ page }) => {
  await page.goto("./");
  const row = waiting(page).locator(".cap-row").first();
  await expect(row).toBeVisible();
  const before = await row.evaluate((el) => el.getBoundingClientRect().top);
  await page.waitForTimeout(1500);
  expect(await row.evaluate((el) => el.getBoundingClientRect().top)).toBe(before);
});

test("with nothing open each part says so in one line", async ({ page }) => {
  await quiet(page);
  await visit(page, "board");
  await expect(waiting(page).getByText("Nothing waits on you.")).toBeVisible();
  await expect(waiting(page).locator(".cap-row")).toHaveCount(0);
  await expect(page.locator("#handoffs").getByText("No open handoff.")).toBeVisible();
  await expect(page.locator("#threads").getByText("No thread in 21 days.")).toBeVisible();
  await expect(
    page.locator("#pr-trouble").getByText(/Could not read the pull requests/),
  ).toBeVisible();
});
