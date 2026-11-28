import { expect, test, type Page } from "@playwright/test";

// The defect these guard: a Preview that did nothing and said nothing. Every path must end in something visible.

const PREVIEW_URL = "**/api/actions/preview";
const PERFORM_URL = "**/api/actions/perform";
const AGENT = "sample-d-driver";

async function openRevokeDialog(page: Page) {
  await page.goto(`agents/agent/${AGENT}`);
  await page.locator("dialog.drawer[open]").getByRole("button", { name: "Revoke" }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Revoke previews as it opens, performs, and the result stays in the message", async ({
  page,
}) => {
  // The perform is answered with the feed unchanged, so the agent stays live for every other spec.
  await page.route(PERFORM_URL, async (route) => {
    const feed = await (await page.request.get("api/ops")).json();
    await route.fulfill({
      json: { action: "revoke_agent", summary: `Revoked ${AGENT}.`, warning: null, feed },
    });
  });
  const dialog = await openRevokeDialog(page);
  await expect(dialog.locator("[data-summary]")).toBeVisible();
  await expect(dialog.getByText("What changes")).toBeHidden();
  await dialog.getByText("Details", { exact: true }).click();
  await expect(dialog.getByText("What changes")).toBeVisible();
  await expect(dialog.getByText("Audit rows it writes")).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke agent", exact: true }).click();
  await expect(page.locator("dialog.confirm")).toBeHidden();
  await expect(page.locator(".cap-message")).toContainText(`Revoked ${AGENT}.`);
});

test("a refusal from the Worker is shown in the dialog, verbatim", async ({ page }) => {
  await page.route(PREVIEW_URL, (route) =>
    route.fulfill({
      status: 403,
      contentType: "text/plain",
      body: "csrf validation failed: reload Capsid Portal and try again.",
    }),
  );
  const dialog = await openRevokeDialog(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "csrf validation failed: reload Capsid Portal and try again.",
  );
});

test("a request the network drops is shown in the dialog", async ({ page }) => {
  await page.route(PREVIEW_URL, (route) => route.abort("connectionreset"));
  const dialog = await openRevokeDialog(page);
  await expect(dialog.getByRole("alert")).toContainText("Could not reach the server");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeEnabled();
});

test("a preview with no answer ends in a message, not a dialog stuck busy", async ({ page }) => {
  await page.clock.install();
  await page.route(PREVIEW_URL, () => undefined);
  const dialog = await openRevokeDialog(page);
  await page.clock.runFor(21_000);
  await expect(dialog.getByRole("alert")).toContainText("no answer within 20 seconds");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeEnabled();
});

test.describe("on a phone", () => {
  // A mobile browser widens its layout viewport when a page overflows, so a centered dialog sat off screen (at 390 px the document was 1189 px wide).
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("the dialog and its buttons are on screen", async ({ page }) => {
    const dialog = await openRevokeDialog(page);
    await expect(dialog.locator("[data-summary]")).toBeVisible();
    await dialog.getByText("Details", { exact: true }).tap();
    await expect(dialog.getByText("What changes")).toBeVisible();
    for (const name of ["Revoke agent", "Cancel"]) {
      await expect(dialog.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
  });
});
