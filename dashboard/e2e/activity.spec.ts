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
