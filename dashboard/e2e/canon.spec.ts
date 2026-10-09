import { expect, test } from "@playwright/test";

// A driver's proposed change to a canon document, reviewed in the Queue (src/canon.ts,
// docs/portal.md). The journey that must not break: the reviewer sees the lines that
// read as instructions to agents before the button that writes canon, and focus starts
// on Cancel, because the approval writes a document every agent trusts.

const PERFORM_URL = "**/portal/api/actions/perform";

test("Review previews the instruction-shaped lines first, focuses Cancel, and Approve and write performs", async ({ page }) => {
  // Answered here with the feed unchanged, so the proposal stays for every other spec.
  await page.route(PERFORM_URL, async (route) => {
    const feed = await (await page.request.get("api/ops")).json();
    await route.fulfill({ json: { action: "canon_approve", summary: "Approved proposal 8.", warning: null, feed } });
  });
  await page.goto("queue");
  const row = page.locator('[data-canon="8"]');
  await expect(row).toContainText("sample-b/decisions.md");
  await expect(row).toContainText("1 line reads as instructions to agents");
  await row.getByRole("button", { name: "Review" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog.getByText("instruction: - Agents must call write on core.md after every job.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Approve and write" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".msg-region")).toContainText("Approved proposal 8.");
});
