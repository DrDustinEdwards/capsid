import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// The eight missing screens (docs/design/design-portal-evaluation.md, DECIDE 3, ruled
// 2026-10-09; job_d62abdbfc270 PR 3): supersede, the question mark, park and unpark, the
// digest strip, the Tonight plan, PR close and the claims export. The eighth, the
// Worker's stale rules, is the Queue's Stale jobs panel (e2e/stale.spec.ts).
//
// The mock's state is shared by every spec, so each change here is undone (park, unpark)
// or answered by a route that leaves the feed as it was (supersede, PR close).

const PERFORM_URL = "**/portal/api/actions/perform";
const QUESTION = "job_91b3c0de5a24";
const QUEUED = "job_9ab0bcf483ae";
const PARKED = "job_5e0aa1b2c3d4";

const drawer = (page: Page) => page.locator("dialog.drawer[open]");
const dialog = (page: Page) => page.locator("dialog.confirm");

// Types a reason, previews, and returns the dialog with its preview up.
async function previewWith(page: Page, reason: string | null, details = true) {
  const d = dialog(page);
  await expect(d).toBeVisible();
  // An action that takes no reason previews as the dialog opens.
  if (reason !== null) {
    await d.getByLabel("Reason (required)").pressSequentially(reason);
    await d.getByRole("button", { name: "Preview" }).click();
  }
  // The plain sentence is up; what changes is behind Details (UX audit M5), opened here.
  await expect(d.locator("[data-summary]")).toBeVisible();
  if (details) {
    await d.getByText("Details", { exact: true }).click();
    await expect(d.getByText("What changes")).toBeVisible();
  }
  return d;
}

// Answers the perform with the feed as it is, so nothing changes for the other specs.
async function performLeavesFeed(page: Page, action: string, summary: string) {
  await page.route(PERFORM_URL, async (route) => {
    const feed = await (await page.request.get("api/ops")).json();
    await route.fulfill({ json: { action, summary, warning: null, feed } });
  });
}

test("a blocked job that asks something is marked Question in the Queue, and its drawer asks and offers Answer", async ({ page }) => {
  await visit(page, "queue");
  const row = page.locator(`main #jobs [data-open="job:${QUESTION}"]`);
  await expect(row).toHaveAttribute("data-question", "");
  await expect(row.locator(".st")).toHaveText("Question");
  await expect(row).toContainText("Asks: Read the design");
  await expect(row).not.toContainText("QUESTION:");
  await row.click();
  await expect(drawer(page).locator("[data-question]")).toContainText("Read the design and answer its DECIDE list");
  await expect(drawer(page).getByText("Run this")).toHaveCount(0);
  await drawer(page).getByRole("button", { name: "Answer", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { level: 2 })).toContainText("Answer:");
});

test("PLANT: Park asks a reason, the job moves to Parked with it, and Undo puts it back in the queue", async ({ page }) => {
  await page.goto(`queue/job/${QUEUED}`);
  await drawer(page).getByRole("button", { name: "Park", exact: true }).click();
  const d = await previewWith(page, "comes back after the release");
  await d.getByRole("button", { name: "Park job", exact: true }).click();
  await expect(page.locator(".msg-region")).toContainText(`Parked ${QUEUED}.`);
  await page.keyboard.press("Escape");
  const parked = page.locator(`main #jobs [data-group="parked"] [data-open="job:${QUEUED}"]`);
  await expect(parked).toContainText("Comes back: comes back after the release");
  // Undo: the reverse action, recorded as its own row.
  await page.locator(".msg-region").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".msg-region")).toContainText("Undone.");
  await expect(page.locator(`main #jobs [data-group="queued"] [data-open="job:${QUEUED}"]`)).toBeVisible();
});

test("a parked job's drawer says when it comes back and offers Unpark, which Undo parks again", async ({ page }) => {
  await page.goto(`queue/job/${PARKED}`);
  await expect(drawer(page)).toContainText("comes back when the methods note is ruled");
  await drawer(page).getByRole("button", { name: "Unpark", exact: true }).click();
  // Unpark asks no reason: it changes nothing a reason would explain.
  const d = await previewWith(page, null);
  await d.getByRole("button", { name: "Unpark job", exact: true }).click();
  await expect(page.locator(".msg-region")).toContainText(`Unparked ${PARKED}`);
  // The drawer is modal; the result and its Undo are under it until it closes.
  await page.keyboard.press("Escape");
  await page.locator(".msg-region").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".msg-region")).toContainText("Undone.");
  await expect(page.locator(`main #jobs [data-group="parked"] [data-open="job:${PARKED}"]`)).toContainText("comes back when the methods note is ruled");
});

test("Supersede is offered on a queued job, not on a blocked one, and previews before it ends the job", async ({ page }) => {
  await page.goto(`queue/job/${QUESTION}`);
  await expect(drawer(page).getByRole("button", { name: "Supersede", exact: true })).toHaveCount(0);
  await performLeavesFeed(page, "supersede_job", `Superseded ${QUEUED}.`);
  await page.goto(`queue/job/${QUEUED}`);
  // Supersede is one of the job's More actions (UX audit M9).
  await drawer(page).getByText("More actions").click();
  await drawer(page).getByRole("button", { name: "Supersede", exact: true }).click();
  // Details stays closed, so focus is where the dialog put it.
  const d = await previewWith(page, "a duplicate of the health job", false);
  await expect(d).toContainText("superseded");
  // One-way: focus goes to Cancel once the preview is up.
  await expect(d.getByRole("button", { name: "Cancel" })).toBeFocused();
  await d.getByRole("button", { name: "Supersede job", exact: true }).click();
  await expect(page.locator(".msg-region")).toContainText(`Superseded ${QUEUED}.`);
});

test("a pull request awaiting the seat has Close, which asks a reason and previews the close", async ({ page }) => {
  await visit(page, "prs");
  const awaiting = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Waiting for you" }) });
  const close = awaiting.getByRole("button", { name: /^Close / }).first();
  const name = (await close.getAttribute("aria-label"))!.replace(/^Close /, "");
  await performLeavesFeed(page, "pr_close", `Closed ${name}.`);
  await close.click();
  const d = await previewWith(page, "replaced by a newer pull request");
  await expect(d).toContainText("open -> closed, not merged");
  await d.getByRole("button", { name: "Close pull request", exact: true }).click();
  await expect(page.locator(".msg-region")).toContainText(`Closed ${name}.`);
});

test("a pull request classed approve has Approve, which previews the approval at the head the tick judged", async ({ page }) => {
  await visit(page, "prs");
  const awaiting = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Waiting for you" }) });
  await performLeavesFeed(page, "approve_pr", "Approved example-org/sample-c#32. It merges once CI is green on 4f2c9a1.");
  await awaiting.getByRole("button", { name: "Approve example-org/sample-c #32", exact: true }).click();
  const d = await previewWith(page, null);
  await expect(d).toContainText("approved at 4f2c9a1");
  await d.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".msg-region")).toContainText("Approved example-org/sample-c#32. It merges once CI is green on 4f2c9a1.");
});

test("the Queue's Tonight section lists the planned jobs per repo, marks a gated one, and a row opens its job", async ({ page }) => {
  await visit(page, "queue");
  const tonight = page.locator("main section#tonight");
  await expect(tonight.getByRole("heading", { level: 2, name: "Tonight" })).toBeVisible();
  const planned = tonight.locator("[data-lane] [data-open^='job:']");
  await expect(planned).toHaveCount(4);
  await expect(tonight).toContainText("about 60 min, default");
  // A parked job is never planned.
  await expect(tonight.locator(`[data-open="job:${PARKED}"]`)).toHaveCount(0);
  await planned.first().click();
  await expect(drawer(page)).toBeVisible();
});

test("Needs you shows what happened since this browser last looked, and the next visit reports from then", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/portal/api/digest")) asked.push(new URL(r.url()).searchParams.get("since") ?? "");
  });
  await visit(page, "needs");
  const strip = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Since you last looked" }) });
  await expect(strip.locator("[data-digest]")).toContainText("finished");
  await expect(strip.locator("[data-digest]")).toContainText("ready for you");
  await page.reload();
  await expect(strip.locator("[data-digest]")).toBeVisible();
  expect(asked.length).toBeGreaterThanOrEqual(2);
  // The first visit had no record, so it asked for the last 24 hours; the second asked
  // from the first visit's time, which is later.
  expect(Date.parse(asked[asked.length - 1]!)).toBeGreaterThan(Date.parse(asked[0]!));
});

test("the claims export downloads each table as CSV, under the filter in force, a formula-like cell defused", async ({ page }) => {
  await visit(page, "claims");
  const exportBar = page.getByRole("group", { name: "Export" });
  for (const [button, file, header] of [
    ["By agent", /^claims-by-agent-\d{4}-\d{2}-\d{2}\.csv$/, /^agent,namespace,jobs,claims,/],
    ["Waits", /^claims-waits-\d{4}-\d{2}-\d{2}\.csv$/, /^namespace,gate_class,ended_by,waits,waited_ms_total,waited_ms_median\r\n/],
    ["Usage", /^claims-usage-\d{4}-\d{2}-\d{2}\.csv$/, /^namespace,source,rows,cost_usd,/],
  ] as const) {
    const [download] = await Promise.all([page.waitForEvent("download"), exportBar.getByRole("button", { name: button, exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(file);
    const text = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
    expect(text).toMatch(header);
    if (button === "By agent") {
      expect(text).toContain("agent:sample-driver,sample,");
      // No cell begins with a formula character a spreadsheet would run.
      for (const line of text.trim().split("\r\n").slice(1)) for (const cell of line.split(",")) expect(cell).not.toMatch(/^[=+@]/);
    }
  }
});
