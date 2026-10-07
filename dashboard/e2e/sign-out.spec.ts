import { expect, test } from "@playwright/test";

// Sign out, clicked in a real browser against the production build. It must send the
// CSRF header the feed carried, and the page after it must say the person chose to
// leave, not that the session expired. A failed sign-out must be said, because a
// session left open on a shared screen is the case the button exists for.

const SIGN_OUT_URL = "**/portal/api/sign-out";

test("Sign out posts with the feed's CSRF value and shows the signed-out page", async ({ page }) => {
  const sent: Array<{ method: string; csrf: string | null }> = [];
  await page.route(SIGN_OUT_URL, (route) => {
    const req = route.request();
    sent.push({ method: req.method(), csrf: req.headers()["x-capsid-csrf"] ?? null });
    return route.continue();
  });
  await page.goto("");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  await expect(page.getByText("You signed out of Capsid Portal in this browser.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/portal/");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.csrf, "the sign-out carried no CSRF header").toBeTruthy();
});

test("a refused sign-out is said, and the session stays on screen", async ({ page }) => {
  await page.route(SIGN_OUT_URL, (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "csrf validation failed: reload Capsid Portal and try again." }));
  await page.goto("");
  await page.getByRole("button", { name: "Your account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText(/Sign out failed: csrf validation failed/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeHidden();
});
