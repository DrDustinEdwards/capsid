import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { visit } from "../e2e/views.ts";
import type { ViewId } from "../src/app/ctx.ts";
import { SHOTS_NOW } from "./clock.ts";

// The README screenshots, from sample data only (dev/sample-feed.json and the responses
// dev/mock-api.ts seeds; scripts/shots-privacy.mjs has checked both before this runs).
// Run: npm run build, then npm run shots. Each PNG lands in the repo's docs/images.
//
// Nothing here performs a control: the Namespaces shot stops at the preview, and the
// mock's state is never changed.

const OUT = fileURLToPath(new URL("../../docs/images/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../dev/sample-feed.json", import.meta.url));

type Theme = "light" | "dark";

// Before the app starts: the theme the app would restore (lib/prefs.ts, wf-theme), the
// matching colour scheme, and the browser's clock pinned to the mock's.
async function prepare(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("wf-theme", t);
    } catch (e) {
      console.warn("shots: could not set wf-theme", e);
    }
  }, theme);
  await page.clock.setFixedTime(new Date(SHOTS_NOW));
}

async function open(page: Page, view: ViewId, theme: Theme = "light"): Promise<void> {
  await prepare(page, theme);
  await visit(page, view);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false, animations: "disabled", caret: "hide", scale: "css" });
}

test("the pinned clock is the fixture's own now", () => {
  const feed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { live: { generated: string } };
  expect(feed.live.generated).toBe(SHOTS_NOW);
});

test("overview, light", async ({ page }) => {
  await open(page, "overview");
  await shoot(page, "overview-light");
});

test("overview, dark", async ({ page }) => {
  await open(page, "overview", "dark");
  await shoot(page, "overview-dark");
});

test("sites, light", async ({ page }) => {
  await open(page, "sites");
  await shoot(page, "sites-light");
});

test("queue with a job drawer open, light", async ({ page }) => {
  await open(page, "queue");
  await page.locator('main [data-open^="job:"]').first().click();
  const drawer = page.locator("aside.drawer.on");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("aria-hidden", "false");
  await expect.poll(() => drawer.evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  await shoot(page, "queue-drawer-light");
});

test("namespaces with a control's preview open, light", async ({ page }) => {
  await open(page, "namespaces");
  const row = page.locator("tr[data-row]").filter({ hasText: "sample-b" });
  await row.getByRole("button", { name: "Pause", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reason (required)").pressSequentially("maintenance window");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByText("What changes")).toBeVisible();
  // Stops at the preview: "Do it" is on screen and never pressed.
  await expect(dialog.getByRole("button", { name: "Do it" })).toBeVisible();
  await shoot(page, "namespaces-preview-light");
});

test("activity, light", async ({ page }) => {
  await open(page, "activity");
  await shoot(page, "activity-light");
});

test("claims, light", async ({ page }) => {
  await open(page, "claims");
  await shoot(page, "claims-light");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });

  test("overview, light", async ({ page }) => {
    await open(page, "overview");
    await shoot(page, "phone-overview-light");
  });
});
