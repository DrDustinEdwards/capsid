import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The Library (capsid/decisions.md 2026-10-09, Portal review item 4), on the dev mock's
// sample answers: three shelves, a search that marks its match, and a document whose job
// id opens that job's drawer and whose linked document opens in place. Read-only: the
// page has no control that writes.

test("PLANT: the shelves list decisions, rulings and research, each document a link", async ({ page }) => {
  await visit(page, "library");
  for (const [shelf, title] of [
    ["Decisions", "Sample decisions log"],
    ["Rulings", "The quokka layout"],
    ["Research", "Layouts compared"],
  ] as const) {
    const panel = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: shelf }) });
    await expect(panel.getByRole("link", { name: title })).toBeVisible();
  }
});

test("a search marks what matched, and a result opens the document", async ({ page }) => {
  await visit(page, "library");
  const form = page.getByRole("search");
  await form.getByRole("searchbox", { name: "Search the knowledge store" }).fill("quokka");
  await form.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\?q=quokka/);
  const results = page.locator(".lib-results li");
  await expect(results).toHaveCount(3);
  await expect(results.first().locator("strong").first()).toHaveText(/quokka/i);
  await page.getByRole("link", { name: "Layouts compared" }).click();
  await expect(page.locator(".lib-body")).toContainText("measured on example.com");
});

test("a document's job id opens the job's drawer, and a linked document opens in place", async ({ page }) => {
  await visit(page, "library");
  await page.getByRole("link", { name: "Sample decisions log" }).click();
  await expect(page.locator(".lib-body")).toContainText("Two themes");
  await page.locator(".lib-edges").getByRole("link", { name: "sample/rulings/quokka-layout.md" }).click();
  await expect(page.locator(".lib-body")).toContainText("Three columns");
  await page.goBack();
  await page.locator(".lib-body").getByRole("link", { name: "job_7c1e44b0a912" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/library\/job\/job_7c1e44b0a912\?doc=/);
});

test("nothing on the page writes: its only button is Search", async ({ page }) => {
  await visit(page, "library");
  await expect(page.locator("main .page button")).toHaveText(["Search"]);
});
