import { expect, test, type Page, type Request } from "@playwright/test";
import { visit } from "./views.ts";

function previews(page: Page): Array<{ action: string; params: Record<string, string> }> {
  const sent: Array<{ action: string; params: Record<string, string> }> = [];
  page.on("request", (r: Request) => {
    if (r.method() === "POST" && r.url().endsWith("/api/actions/preview"))
      sent.push(r.postDataJSON() as { action: string; params: Record<string, string> });
  });
  return sent;
}

const waiting = (page: Page) => page.locator("#waiting");
const group = (page: Page, id: string) => page.locator(`[data-group="${id}"]`);
const dialog = (page: Page) => page.locator("dialog.confirm");

test("PLANT: the home is Needs you, and the list comes first by kind", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Needs you" })).toBeVisible();
  await expect(waiting(page).locator(".cap-group-heading")).toHaveText([
    /^Questions and blocked jobs, ?3/,
    /^Paused after repeated failures, ?1/,
    /^Also waiting, ?2/,
  ]);
  const order = await page.evaluate(() =>
    ["#waiting", "#attention"].map((s) => document.querySelector(s)!.getBoundingClientRect().top),
  );
  expect(order[0]).toBeLessThan(order[1]!);
  await expect(
    page.locator("header.cap-site-header").getByRole("link", { name: "Inbox, 6 waiting on you" }),
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
  const h = page.locator('[data-group="w-jobs"] .cap-group-heading');
  await expect(h).toBeVisible();
  const before = await h.evaluate((el) => el.getBoundingClientRect().top);
  await page.waitForTimeout(1500);
  expect(await h.evaluate((el) => el.getBoundingClientRect().top)).toBe(before);
});

test("PLANT: Answer opens a reply box on the row, and Send previews resume_job with the reply as its reason", async ({
  page,
}) => {
  const sent = previews(page);
  await visit(page, "needs");
  const row = group(page, "w-jobs").locator(".cap-row", { hasText: "Asks: Read the design" });
  await expect(row).toContainText("Asks: Read the design");
  await row.getByRole("button", { name: /^Answer / }).click();
  const box = row.getByLabel("Your answer, sent to its driver");
  await expect(box).toBeFocused();
  await row.getByRole("button", { name: "Send" }).click();
  await expect(row.getByRole("alert")).toHaveText("Type your answer first.");
  expect(sent).toEqual([]);
  await box.fill("Option B, and keep the old table.");
  await row.getByRole("button", { name: "Send" }).click();
  await expect(dialog(page).locator("[data-given-reason]")).toHaveText(
    "Option B, and keep the old table.",
  );
  await expect(dialog(page).getByRole("button", { name: "Resume job", exact: true })).toBeVisible();
  expect(sent).toEqual([
    {
      action: "resume_job",
      params: {
        id: "job_91b3c0de5a24",
        reason: "Option B, and keep the old table.",
      },
    },
  ]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});

test("Resume on a blocked job row previews resume_job; its title opens its panel", async ({
  page,
}) => {
  const sent = previews(page);
  await visit(page, "needs");
  const row = group(page, "w-jobs").locator(".cap-row", {
    hasText: "Sync the score block onto the open scorer PR",
  });
  await row.getByRole("button", { name: /^Resume / }).click();
  await row.getByLabel("What you did or approved, sent to its driver").fill("merged #15");
  await row.getByRole("button", { name: "Send" }).click();
  await expect(dialog(page).getByRole("button", { name: "Resume job", exact: true })).toBeVisible();
  expect(sent).toEqual([
    {
      action: "resume_job",
      params: { id: "job_15e10168e61c", reason: "merged #15" },
    },
  ]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await row.getByRole("button", { name: "Sync the score block onto the open scorer PR" }).click();
  await expect(page.locator("dialog.drawer[open]")).toBeVisible();
});

test("PLANT: a stopped queue is here with Reset, which previews reset_breaker for its namespace", async ({
  page,
}) => {
  const sent = previews(page);
  await visit(page, "needs");
  const row = group(page, "w-stops").locator(".cap-row", { hasText: "sample-b" });
  await expect(row).toContainText("No job here starts until you reset it.");
  await row.getByRole("button", { name: "Reset sample-b" }).click();
  await expect(dialog(page).getByRole("button", { name: "Reset and resume" })).toBeVisible();
  expect(sent).toEqual([{ action: "reset_breaker", params: { namespace: "sample-b" } }]);
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});

test("with nothing waiting it says so", async ({ page }) => {
  await page
    .context()
    .addCookies([{ name: "wf-mock", value: "quiet", url: "http://localhost:4174/" }]);
  await visit(page, "needs");
  await expect(waiting(page).getByText("Nothing needs you.")).toBeVisible();
  await expect(waiting(page).locator(".cap-group")).toHaveCount(0);
});
