import { expect, test, type Page, type Request } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// Needs you, the home (docs/design/design-portal-evaluation.md DECIDE 1; the UX audit of
// 2026-10-19, B1, B3 and M3): everything waiting for you first, by kind, each row deciding
// in place through the existing controls; then Problems; the charts folded at the foot.

const PREVIEW_URL = "**/portal/api/actions/preview";
const PERFORM_URL = "**/portal/api/actions/perform";

async function reshape(page: Page, fn: (f: OpsFeed) => void): Promise<void> {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    fn(feed);
    await route.fulfill({ response: res, json: feed });
  });
}

// Every control the page sends to preview, in order, as { action, params }.
function previews(page: Page): Array<{ action: string; params: Record<string, string> }> {
  const sent: Array<{ action: string; params: Record<string, string> }> = [];
  page.on("request", (r: Request) => {
    if (r.method() === "POST" && r.url().endsWith("/api/actions/preview")) sent.push(r.postDataJSON() as { action: string; params: Record<string, string> });
  });
  return sent;
}

// Performs are answered here with the feed as it is, so the mock's state stays for every
// other spec, and counted.
async function performsLeaveFeed(page: Page, summary: string): Promise<{ count: number }> {
  const seen = { count: 0 };
  await page.route(PERFORM_URL, async (route) => {
    seen.count++;
    const feed = await (await page.request.get("api/ops")).json();
    await route.fulfill({ json: { action: "approve_pr", summary, warning: null, feed } });
  });
  return seen;
}

const waiting = (page: Page) => page.locator("#waiting");
const group = (page: Page, id: string) => page.locator(`[data-group="${id}"]`);
const dialog = (page: Page) => page.locator("dialog.confirm");

test("PLANT: the home is Needs you, the list comes first by kind, and the charts are folded at the foot", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1, name: "Needs you" })).toBeVisible();
  await expect(waiting(page).locator(".wgroup h3")).toHaveText([/^Pull requests 2/, /^Questions and blocked jobs 3/, /^Paused after repeated failures 1/, /^Also waiting 2/]);
  // The list is above Problems and Trends, and nothing above it waits on a chart.
  const order = await page.evaluate(() => ["#waiting", "#attention", "#trends"].map((s) => document.querySelector(s)!.getBoundingClientRect().top));
  expect(order[0]).toBeLessThan(order[1]!);
  expect(order[1]).toBeLessThan(order[2]!);
  await expect(page.locator("#trends")).not.toHaveAttribute("open", "");
  await expect(page.locator("#trends .cap-chart")).toHaveCount(0);
  await expect(waiting(page).getByText(/^Nothing waiting: /)).toContainText("Sample D");
  // The inbox's count is the header's Inbox, once; the menu entry carries no second copy.
  await expect(page.locator("header.cap-site-header").getByRole("link", { name: "Inbox, 7 waiting on you" })).toHaveCount(1);
  await expect(page.locator("nav.cap-admin-menu").getByRole("link", { name: /^Needs you/ })).toHaveAccessibleName("Needs you");
  // A pull request's GitHub page is a small secondary link, not the row's action.
  await expect(group(page, "w-prs").getByRole("link", { name: "Open on GitHub" }).first()).toHaveAttribute("href", "https://github.com/example-org/sample-c/pull/32");
  // Problems leave out what the list above decides.
  await expect(page.getByRole("heading", { level: 2, name: "Problems" })).toBeVisible();
  await expect(page.locator("#attention").getByText(/waiting on you|await the seat|canon proposal/)).toHaveCount(0);
});

test("PLANT: the list does not move once the page has loaded, and Trends draws its charts in reserved room", async ({ page }) => {
  await page.goto("./");
  const h = page.locator('[data-group="w-prs"] h3');
  await expect(h).toBeVisible();
  const before = await h.evaluate((el) => el.getBoundingClientRect().top);
  await page.waitForTimeout(1500);
  expect(await h.evaluate((el) => el.getBoundingClientRect().top)).toBe(before);
  const body = page.locator("#trends .trends-body");
  await page.locator("#trends > summary").click();
  await expect(page.locator("#trends")).toHaveAttribute("open", "");
  expect(await body.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(300);
  await expect(page.locator("#trends .minutes-chart, #trends .wait-chart, #trends .minutes-none").first()).toBeVisible();
});

test("PLANT: Approve on a pull request row previews approve_pr at the head the tick judged, then performs", async ({ page }) => {
  const sent = previews(page);
  const done = await performsLeaveFeed(page, "Approved example-org/sample-c#32.");
  await visit(page, "needs");
  await group(page, "w-prs").getByRole("button", { name: "Approve example-org/sample-c #32", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "Approve pull request example-org/sample-c #32" })).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  expect(sent).toEqual([{ action: "approve_pr", params: { namespace: "sample-c", repo: "example-org/sample-c", prs: "32", shas: "4f2c9a1e8b7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f" } }]);
  await dialog(page).getByRole("button", { name: "Approve", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  expect(done.count).toBe(1);
  await expect(page.locator(".msg-region")).toContainText("Approved example-org/sample-c#32.");
});

test("PLANT: Close on a pull request row asks a reason, then previews pr_close with it", async ({ page }) => {
  const sent = previews(page);
  await visit(page, "needs");
  await group(page, "w-prs").getByRole("button", { name: "Close example-org/sample-c #33", exact: true }).click();
  await dialog(page).getByRole("textbox", { name: "Reason", exact: true }).fill("replaced by a newer pull request");
  await dialog(page).getByRole("button", { name: "Preview" }).click();
  await expect(dialog(page).getByRole("button", { name: "Close pull request", exact: true })).toBeVisible();
  expect(sent).toEqual([{ action: "pr_close", params: { namespace: "sample-c", repo: "example-org/sample-c", number: "33", reason: "replaced by a newer pull request" } }]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toBeHidden();
});

test("PLANT: ticking two pull requests approves both in one confirm, each previewed and performed as its own approve_pr", async ({ page }) => {
  const sent = previews(page);
  const done = await performsLeaveFeed(page, "Approved one.");
  await visit(page, "needs");
  const prs = group(page, "w-prs");
  await expect(prs.getByRole("button", { name: /selected$/ })).toHaveCount(0);
  await prs.getByRole("checkbox", { name: "Select all" }).check();
  await prs.getByRole("button", { name: "Approve 2 selected" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Approve 2 pull requests" })).toBeVisible();
  await expect(dialog(page).locator("[data-batch-item]")).toHaveCount(2);
  await expect(dialog(page).getByRole("button", { name: "Approve 2" })).toBeVisible();
  expect(sent.map((s) => [s.action, s.params.prs])).toEqual([
    ["approve_pr", "32"],
    ["approve_pr", "33"],
  ]);
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog(page).getByRole("button", { name: "Approve 2" }).click();
  await expect(dialog(page)).toBeHidden();
  expect(done.count).toBe(2);
  await expect(page.locator(".msg-region")).toContainText("Approved one. Approved one.");
});

test("PLANT: Answer opens a reply box on the row, and Send previews resume_job with the reply as its reason", async ({ page }) => {
  const sent = previews(page);
  await visit(page, "needs");
  const row = group(page, "w-jobs").locator('[data-job="job_91b3c0de5a24"]');
  await expect(row).toContainText("Asks: Read the design");
  await row.getByRole("button", { name: /^Answer / }).click();
  const box = row.getByLabel("Your answer, sent to its driver");
  await expect(box).toBeFocused();
  // Send with nothing typed says so and sends nothing.
  await row.getByRole("button", { name: "Send" }).click();
  await expect(row.getByRole("alert")).toHaveText("Type your answer first.");
  expect(sent).toEqual([]);
  await box.fill("Option B, and keep the old table.");
  await row.getByRole("button", { name: "Send" }).click();
  await expect(dialog(page).locator("[data-given-reason]")).toHaveText("Option B, and keep the old table.");
  await expect(dialog(page).getByRole("button", { name: "Resume job", exact: true })).toBeVisible();
  expect(sent).toEqual([{ action: "resume_job", params: { id: "job_91b3c0de5a24", reason: "Option B, and keep the old table." } }]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});

test("Resume on a blocked job row previews resume_job; More about this job opens its panel", async ({ page }) => {
  const sent = previews(page);
  await visit(page, "needs");
  const row = group(page, "w-jobs").locator('[data-job="job_15e10168e61c"]');
  await row.getByRole("button", { name: /^Resume / }).click();
  await row.getByLabel("What you did or approved, sent to its driver").fill("merged #15");
  await row.getByRole("button", { name: "Send" }).click();
  await expect(dialog(page).getByRole("button", { name: "Resume job", exact: true })).toBeVisible();
  expect(sent).toEqual([{ action: "resume_job", params: { id: "job_15e10168e61c", reason: "merged #15" } }]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await row.getByRole("button", { name: "More about this job" }).click();
  await expect(page.locator("dialog.drawer[open]")).toBeVisible();
});

test("PLANT: a stopped queue is here with Reset, which previews reset_breaker for its namespace", async ({ page }) => {
  const sent = previews(page);
  await visit(page, "needs");
  const row = group(page, "w-stops").locator('[data-stop="sample-b"]');
  await expect(row).toContainText("No job here starts until you reset it.");
  await row.getByRole("button", { name: "Reset sample-b" }).click();
  await expect(dialog(page).getByRole("button", { name: "Reset and resume" })).toBeVisible();
  expect(sent).toEqual([{ action: "reset_breaker", params: { namespace: "sample-b" } }]);
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});

test("on a phone each row's buttons are full width and at least 44 px tall, and the first is on the first screen", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await visit(page, "needs");
  const approve = group(page, "w-prs").getByRole("button", { name: "Approve example-org/sample-c #32", exact: true });
  const close = group(page, "w-prs").getByRole("button", { name: "Close example-org/sample-c #32", exact: true });
  const a = (await approve.boundingBox())!;
  const c = (await close.boundingBox())!;
  expect(a.height).toBeGreaterThanOrEqual(44);
  expect(a.width + c.width).toBeGreaterThan(300);
  expect(a.y + a.height).toBeLessThan(915);
});

test("with nothing waiting it says so, and every app is named as quiet", async ({ page }) => {
  await reshape(page, (f) => {
    f.live.inbox = { ...f.live.inbox, count: 0, severity: "none", apps: f.live.inbox.apps.map((a) => ({ ...a, count: 0, severity: "none", items: [] })) };
  });
  await page.route("**/portal/api/namespaces", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const n of body.namespaces) n.breaker.open = false;
    await route.fulfill({ response: res, json: body });
  });
  await visit(page, "needs");
  await expect(waiting(page).getByText("Nothing needs you.")).toBeVisible();
  await expect(waiting(page).locator(".wgroup")).toHaveCount(0);
  await expect(waiting(page).getByText(/^Nothing waiting: /)).toContainText("Sample A");
});

test("a preview refused for one ticked row still lists the others, and names the refusal", async ({ page }) => {
  await page.route(PREVIEW_URL, async (route) => {
    const body = route.request().postDataJSON() as { params: Record<string, string> };
    if (body.params.prs === "33") return route.fulfill({ status: 400, contentType: "text/plain", body: "#33 moved: its head is new now." });
    return route.fallback();
  });
  await visit(page, "needs");
  const prs = group(page, "w-prs");
  await prs.getByRole("checkbox", { name: "Select all" }).check();
  await prs.getByRole("button", { name: "Approve 2 selected" }).click();
  await expect(dialog(page).locator('[data-batch-item="example-org/sample-c #33"]')).toContainText("#33 moved");
  await expect(dialog(page).getByRole("button", { name: "Approve 1" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
});
