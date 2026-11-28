import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// The pages Portal v2 changed: each shows its charts, drawn, with their tables, and keeps its links.

const chart = (page: Page, title: string) =>
  page.locator(".cap-chart").filter({ has: page.locator("figcaption", { hasText: title }) });

test("Memory: the handoffs tab draws the year's writes and the weekly handoffs, and filters the list", async ({
  page,
}) => {
  await visit(page, "memory");
  await expect(page.getByRole("link", { name: "Handoffs", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(chart(page, "How often is memory written?").locator("svg[role='img']")).toHaveCount(
    1,
  );
  await expect(
    chart(page, "How often are handoffs written?").locator("svg[role='img']"),
  ).toHaveCount(1);
  const rows = page.locator("#memory-handoffs tbody tr");
  await expect(rows).toHaveCount(6);
  await page.getByLabel("Filter handoffs").fill("drill");
  await expect(rows).toHaveCount(1);
  await page.getByRole("link", { name: "Decisions" }).click();
  await expect(page.locator("#memory-decisions")).toBeVisible();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search memory" }).fill("quokka");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#memory-results li")).toHaveCount(3);
});

test("Pull requests: every open one in a table, oldest first, each linking to GitHub", async ({
  page,
}) => {
  await visit(page, "prs");
  const table = page.getByRole("table", { name: "Data for: Open pull requests" });
  await expect(table.locator("tbody tr")).toHaveCount(5);
  await expect(table.locator("tbody th").first()).toContainText("Draft: backup drill notes");
  await expect(table.getByRole("link", { name: /Rebuild the search index/ })).toHaveAttribute(
    "href",
    "https://github.com/example-org/sample-b/pull/12",
  );
  await expect(page.locator("#open-prs").getByText(/as of/)).toBeVisible();
});

test("Agents: a roster row opens the agent's drawer, and Activity shows who acted", async ({
  page,
}) => {
  await visit(page, "agents");
  const roster = page.getByRole("table", { name: "Data for: Live agents" });
  await expect(roster.locator("tbody tr")).toHaveCount(6);
  await roster.getByRole("link", { name: "watcher", exact: true }).click();
  await expect(page.locator("dialog.drawer[open]")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    chart(page, "Who acted, last 30 days").first().locator("svg[role='img']"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
});

test("Health: open problems by age, and the backups' ages and runs", async ({ page }) => {
  await visit(page, "health");
  await expect(
    chart(page, "How long has each open problem been open?").locator("svg[role='img']"),
  ).toHaveCount(1);
  await page.getByRole("link", { name: "Backups" }).click();
  await expect(chart(page, "Backup age by site").locator("svg[role='img']")).toHaveCount(1);
  await expect(chart(page, "Amazon copy age by site").locator("svg[role='img']")).toHaveCount(1);
  await expect(chart(page, "Backup runs, last 14 days").locator("svg[role='img']")).toHaveCount(1);
  await expect(page.getByText("Weekly", { exact: true })).toBeVisible();
});
