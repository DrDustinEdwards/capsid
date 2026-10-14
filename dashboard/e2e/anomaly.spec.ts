import { expect, test } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";

// An agent acting out of its usual pattern (src/anomaly.ts, OWASP item 6) is a warning row
// in Needs attention, with no job behind it, that says nothing was suspended (Dustin,
// D4 of 2026-10-03). The home page holds the list, whichever page the home is.

test("PLANT: an open anomaly finding is an attention row, with no job behind it", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    feed.live.findings = [
      {
        fingerprint: "anomaly-new-action-sample-driver-delete-namespace",
        namespace: "capsid",
        class: "attention",
        headline: "agent:sample-driver did 'delete_namespace', which it had not done in 14 days",
        first_seen: feed.live.generated,
        last_seen: feed.live.generated,
        seen_count: 1,
        evidence: [],
      },
    ];
    await route.fulfill({ response: res, json: feed });
  });
  await page.goto("./");
  const attention = page.locator("main section.attention");
  const row = attention.locator("[data-row]").filter({ hasText: "agent:sample-driver did 'delete_namespace'" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("nothing suspended");
  await expect(row.locator(".st.warn")).toHaveCount(1);
});

// The watcher's digest-class findings post no job and show as one block per site.
test("PLANT: digest-class findings are a Weekly digest block per site, and attention-class ones are not in it", async ({ page }) => {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    const base = { namespace: "sample", first_seen: feed.live.generated, last_seen: feed.live.generated, seen_count: 2, evidence: ["x"] };
    feed.live.findings = [
      { ...base, fingerprint: "live-csp-script-sample-home", class: "digest", headline: "Sample's CSP blocks the beacon script" },
      { ...base, fingerprint: "live-headers-other-home", namespace: "other", class: "digest", headline: "Other is missing security headers" },
      { ...base, fingerprint: "anomaly-rate-x", class: "attention", headline: "agent:x is unusually busy" },
    ];
    await route.fulfill({ response: res, json: feed });
  });
  await page.goto("./");
  const panel = page.locator("#weekly-digest");
  await expect(panel.locator("[data-digest-site]")).toHaveCount(2);
  await expect(panel).toContainText("Sample's CSP blocks the beacon script");
  await expect(panel).not.toContainText("unusually busy");
});
