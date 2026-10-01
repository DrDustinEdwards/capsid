import { expect, test, type Page } from "@playwright/test";

// The confirm dialog, clicked in a real browser against the production build. The
// defect these guard: on the live Portal a Pause with a typed reason, then Preview,
// did nothing and said nothing. Every path below must end in something visible. Pause
// is a switch now (e2e/switches.spec.ts), so these open "Mark failed" on a queued job,
// the dialog that asks for a reason the same way.

const PREVIEW_URL = "**/portal/api/actions/preview";
const PERFORM_URL = "**/portal/api/actions/perform";
// A queued job no other spec reads.
const JOB = "job_0cdf2803f0ba";

async function openReasonDialog(page: Page) {
  await page.goto(`queue/job/${JOB}`);
  await page.getByRole("button", { name: "Mark failed", exact: true }).click();
  const dialog = page.locator("dialog.confirm");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("Mark failed with a typed reason, then Preview, shows the preview and performs, and the result stays in the message", async ({ page }) => {
  // The perform is answered here with the feed unchanged, so the job stays queued for
  // every other spec that reads the mock.
  await page.route(PERFORM_URL, async (route) => {
    const feed = await (await page.request.get("api/ops")).json();
    await route.fulfill({ json: { action: "fail_job", summary: `Marked ${JOB} failed.`, warning: null, feed } });
  });
  const dialog = await openReasonDialog(page);
  await dialog.getByLabel("Reason (required)").pressSequentially("testing");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("What changes")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Mark failed", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Mark failed", exact: true }).click();
  await expect(page.locator("dialog.confirm")).toBeHidden();
  await expect(page.locator(".msg-region")).toContainText(`Marked ${JOB} failed.`);
});

test("Preview with no reason says a reason is required, and sends nothing", async ({ page }) => {
  let sent = 0;
  await page.route(PREVIEW_URL, (route) => (sent++, route.continue()));
  const dialog = await openReasonDialog(page);
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByRole("alert")).toContainText("A reason is required");
  expect(sent).toBe(0);
});

test("a reason the browser filled in without an input event still previews", async ({ page }) => {
  const dialog = await openReasonDialog(page);
  // Autofill and similar set the field's value with no input event, so the app's state
  // never hears of it. The click must read the field.
  await dialog.getByLabel("Reason (required)").evaluate((el: HTMLTextAreaElement) => {
    el.value = "filled by the browser";
  });
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("What changes")).toBeVisible();
});

test("a refusal from the Worker is shown in the dialog, verbatim", async ({ page }) => {
  await page.route(PREVIEW_URL, (route) =>
    route.fulfill({ status: 403, contentType: "text/plain", body: "csrf validation failed: reload Capsid Portal and try again." })
  );
  const dialog = await openReasonDialog(page);
  await dialog.getByLabel("Reason (required)").pressSequentially("testing");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByRole("alert")).toContainText("csrf validation failed: reload Capsid Portal and try again.");
});

test("a request the network drops is shown in the dialog", async ({ page }) => {
  await page.route(PREVIEW_URL, (route) => route.abort("connectionreset"));
  const dialog = await openReasonDialog(page);
  await dialog.getByLabel("Reason (required)").pressSequentially("testing");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not reach the server");
});

test("a preview with no answer ends in a message, not a dialog stuck busy", async ({ page }) => {
  await page.clock.install();
  // Held, never answered.
  await page.route(PREVIEW_URL, () => undefined);
  const dialog = await openReasonDialog(page);
  await dialog.getByLabel("Reason (required)").pressSequentially("testing");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByRole("button", { name: "Checking..." })).toBeDisabled();
  await page.clock.runFor(21_000);
  await expect(dialog.getByRole("alert")).toContainText("no answer within 20 seconds");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeEnabled();
});

test.describe("on a phone", () => {
  // A mobile browser widens its layout viewport to fit a page that overflows, and a
  // centred dialog then sits off the visible screen. Measured before the fix: at 390 px
  // the document was 1189 px wide (the tab bar), and tapping Preview hit the dialog
  // element instead of the button.
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the dialog and its buttons are on screen", async ({ page }) => {
    const dialog = await openReasonDialog(page);
    for (const name of ["Preview", "Cancel"]) {
      await expect(dialog.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
    }
    await dialog.getByLabel("Reason (required)").pressSequentially("testing");
    await dialog.getByRole("button", { name: "Preview" }).tap();
    await expect(dialog.getByText("What changes")).toBeVisible();
    for (const name of ["Pause", "Cancel"]) {
      await expect(dialog.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
  });
});
