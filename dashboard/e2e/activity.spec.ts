import { expect, test } from "@playwright/test";

// Capsid Portal's Activity view, in a real browser against the production build.
// Reported 2026-09-29: the newest rows read "in 16s" for actions that had just
// happened, and a job's post showed as two identical rows.

const ACTIVITY_URL = "**/portal/api/activity**";

test.use({ timezoneId: "America/Chicago" });

test("PLANT: a row the server wrote at the moment of the read is never shown in the future, even with the server's clock ahead", async ({ page }) => {
  // The server's clock is 40 s ahead of the browser's; the newest row was written as
  // the read ran, and one row is a zone-less D1 timestamp from ten minutes before.
  const serverNow = Date.now() + 40_000;
  const iso = (t: number) => new Date(t).toISOString();
  const d1 = (t: number) => iso(t).slice(0, 19).replace("T", " ");
  await page.route(ACTIVITY_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generated: iso(serverNow),
        filter: { namespace: null, actor: null },
        limit: 50,
        rows: [
          { id: 3, at: iso(serverNow), actor: "agent:sample-driver", action: "write", namespace: "sample", path: "sample/a.md", target: "document" },
          { id: 2, at: iso(serverNow - 8_000), actor: "agent:sample-driver", action: "write", namespace: "sample", path: "sample/b.md", target: "document" },
          { id: 1, at: d1(serverNow - 10 * 60_000), actor: "agent:sample-driver", action: "write", namespace: "sample", path: "sample/c.md", target: "document" },
        ],
      }),
    })
  );
  await page.goto("activity");
  const when = page.locator("tbody tr[data-row] td:first-child");
  await expect(when).toHaveCount(3);
  const texts = await when.allTextContents();
  for (const t of texts) expect(t, `a row reads as in the future: ${texts.join(" | ")}`).not.toMatch(/^in /);
  expect(texts[0]).toMatch(/^\d+s ago$/);
  // Ten minutes, not ten minutes plus Chicago's five or six hours.
  expect(texts[2]).toBe("10m ago");
});

test("a job transition's two rows say which is the job's and which its mirror document's", async ({ page }) => {
  await page.goto("activity");
  const posted = page.locator("tbody tr[data-row]").filter({ hasText: "jobs/job_9ab0bcf483ae.md" });
  await expect(posted).toHaveCount(2);
  await expect(posted.nth(0)).toContainText("job-posted (job)");
  await expect(posted.nth(1)).toContainText("job-posted (mirror document)");
});

// The Activity drawer (job_fe0da37c07e0 PR 2): a row opens the audit row it is, with
// the reason typed, the before and after field by field, and the rest by name.
test("an Activity row opens its audit row: the reason, the before and after, and the named fields", async ({ page }) => {
  await page.goto("activity");
  await page.locator("tbody tr[data-row]").filter({ hasText: "ops-site-edited" }).click();
  const drawer = page.locator("dialog.drawer");
  await expect(drawer.getByRole("heading", { name: "ops-site-edited" })).toBeVisible();
  await expect(page).toHaveURL(/\/activity\/audit\/\d+$/);
  const origin = drawer.locator(".kv.diff dd").first();
  await expect(origin.locator("del")).toHaveText("https://sample-b.example.com");
  await expect(origin.locator("ins")).toHaveText("https://www.sample-b.example.com");
  await expect(drawer.locator(".kv.diff dt")).toHaveText(["Origin", "Health path", "Revision"]);

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/activity$/);
  await page.locator("tbody tr[data-row]").filter({ hasText: "portal-mode" }).click();
  await expect(drawer.locator(".callout.reason")).toHaveText("Nightly runs are paused while the budget resets.");
  await expect(drawer.locator(".kv").last()).toContainText("Mode");
});

test("an audit row opened by its address reads that row; a write's hash is counted, not shown", async ({ page }) => {
  await page.goto("activity/audit/1000");
  const drawer = page.locator("dialog.drawer");
  await expect(drawer.getByRole("heading", { name: "write" })).toBeVisible();
  await expect(drawer).toContainText("1 recorded field is not shown");
});

test("an address naming no audit row says so", async ({ page }) => {
  await page.goto("activity/audit/5");
  await expect(page.locator("dialog.drawer").getByRole("heading", { name: "Audit row #5" })).toBeVisible();
  await expect(page.locator("dialog.drawer")).toContainText("There is no audit row with this id.");
});
