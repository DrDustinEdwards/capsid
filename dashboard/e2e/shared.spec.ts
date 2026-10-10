import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The Shared code view (job_584b4e7f2824), on the dev mock's sample answer: one app two
// releases behind, one current through an old repo name, a Renovate preset, a local copy
// still there and one removed, a package whose tags could not be read, and an app that
// could not be read.

test("PLANT: each shared package lists who is behind and by how much, and the local copies left", async ({ page }) => {
  await visit(page, "shared");
  const kit = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "sample-kit" }) });
  await expect(kit.getByText("newest")).toBeVisible();
  const rows = kit.locator("table.shared-users tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Sample B" })).toContainText("2 releases behind");
  await expect(rows.filter({ hasText: "Sample C" })).toContainText("old repo name");
  await expect(kit.locator(".shared-local li").filter({ hasText: "packages/sample-kit" })).toContainText("Still there");
  await expect(kit.locator(".shared-local li").filter({ hasText: "src/kit" })).toContainText("Removed");
  await expect(kit).toContainText("1 behind");
  await expect(kit).toContainText("1 of 2 local copies left");
});

test("what could not be read is said: an app, and a package's tags", async ({ page }) => {
  await visit(page, "shared");
  await expect(page.locator("main .shared-read")).toContainText("from 7 apps; 1 could not be read: sample-h");
  const dump = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "sample-dump" }) });
  await expect(dump).toContainText("GitHub answered 404");
  await expect(dump).toContainText("No app pins it yet.");
  const devkit = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "sample-devkit" }) });
  await expect(devkit.locator("tbody tr")).toContainText("Unpinned");
});
