import { expect, test } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";

// An agent acting out of its usual pattern (src/anomaly.ts, OWASP item 6) is a warning row
// in Needs attention that opens its finding's job, and says nothing was suspended (Dustin,
// D4 of 2026-10-03). The home page holds the list, whichever page the home is.

test("PLANT: an open anomaly finding is an attention row that opens its job", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    const base = feed.live.jobs.find((j) => j.status === "queued")!;
    feed.live.jobs.push({
      ...base,
      id: "job_00000000a001",
      title: "Watcher: agent:sample-driver did 'delete_namespace', which it had not done in 14 days [anomaly-new-action-sample-driver-delete-namespace]",
      posted_by: "agent:watcher",
      status: "queued",
      finding: { fingerprint: "anomaly-new-action-sample-driver-delete-namespace", seen_count: 1, last_seen: feed.live.generated },
      updated_at: feed.live.generated,
    });
    await route.fulfill({ response: res, json: feed });
  });
  await page.goto("./");
  const attention = page.locator("main section.attention");
  const row = attention.locator("[data-row]").filter({ hasText: "agent:sample-driver did 'delete_namespace'" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("nothing suspended");
  await expect(row.locator(".st.warn")).toHaveCount(1);
  await row.click();
  await expect(page.locator("dialog.drawer[open]")).toBeVisible();
});
