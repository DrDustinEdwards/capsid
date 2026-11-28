import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

const waiting = (page: Page) => page.locator("#waiting");

test("PLANT: the home is Needs you, and what waits comes first", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Needs you" })).toBeVisible();
  await expect(waiting(page).locator(".cap-row")).toHaveCount(2);
  const order = await page.evaluate(() =>
    ["#waiting", "#attention"].map((s) => document.querySelector(s)!.getBoundingClientRect().top),
  );
  expect(order[0]).toBeLessThan(order[1]!);
  await expect(
    page.locator("header.cap-site-header").getByRole("link", { name: "Inbox, 2 waiting on you" }),
  ).toHaveCount(1);
  await expect(
    page.locator("nav.cap-admin-menu").getByRole("link", { name: /^Needs you/ }),
  ).toHaveAccessibleName("Needs you");
  await expect(page.getByRole("heading", { level: 2, name: "Problems" })).toBeVisible();
  await expect(
    page.locator("#attention").getByText(/waiting on you|await the seat|canon proposal/),
  ).toHaveCount(0);
});

test("PLANT: the list does not move once the page has loaded", async ({ page }) => {
  await page.goto("./");
  const row = waiting(page).locator(".cap-row").first();
  await expect(row).toBeVisible();
  const before = await row.evaluate((el) => el.getBoundingClientRect().top);
  await page.waitForTimeout(1500);
  expect(await row.evaluate((el) => el.getBoundingClientRect().top)).toBe(before);
});

test("with nothing waiting it says so", async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: "wf-mock", value: "quiet", url: "http://localhost:4174/" }]);
  await visit(page, "needs");
  await expect(waiting(page).getByText("Nothing needs you.")).toBeVisible();
  await expect(waiting(page).locator(".cap-row")).toHaveCount(0);
});
