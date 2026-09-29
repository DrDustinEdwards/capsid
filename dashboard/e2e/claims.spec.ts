import { expect, test, type Page } from "@playwright/test";
import { expectNoSideways, measure, urlOf, visit } from "./views.ts";

// The Claims view against the production build and the dev mock (dev/mock-api.ts), whose
// claims are fake: four agent groups, and two jobs from the sample feed with claims,
// checks and touches (job_6b5a4c3d2e1f, done; job_7c1e44b0a912, blocked).

const DONE = "job_6b5a4c3d2e1f";
const BLOCKED = "job_7c1e44b0a912";

const groupRows = (page: Page) => page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "By agent" }) }).locator("tr[data-row]");

test("the aggregate lists each agent and namespace with its checks, touches and median wait", async ({ page }) => {
  await visit(page, "claims");
  await expect(groupRows(page)).toHaveCount(4);
  const driver = groupRows(page).filter({ hasText: "agent:sample-driver" });
  await expect(driver).toContainText("sample");
  await expect(driver.locator('td[data-label="Checks"]')).toContainText("disagree 2");
  await expect(driver.locator('td[data-label="Touches"]')).toContainText("gate 3");
  // Three waits of 9m, 30m and 3.2h: the median is the middle one.
  await expect(driver.locator('td[data-label="Median wait"]')).toContainText("30m");
  // A touch on a job nobody has claimed is its own row, never folded into an agent.
  await expect(groupRows(page).filter({ hasText: "no claim yet" })).toHaveCount(1);
  // A group with no measured wait says so, never 0.
  const c = groupRows(page).filter({ hasText: "agent:sample-c-driver" });
  await expect(c.locator('td[data-label="Median wait"]')).toHaveText("no wait");
  // The checks summed across agents.
  const byCheck = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "By check" }) });
  await expect(byCheck.locator("tr[data-row]").filter({ hasText: "ci_green" }).locator('td[data-label="unclaimed"]')).toHaveText("7");
});

test("the namespace filter narrows the rows and lives in the address", async ({ page }) => {
  await visit(page, "claims");
  await page.getByLabel("Namespace", { exact: true }).selectOption("sample-b");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/claims\?namespace=sample-b$/);
  await expect(groupRows(page)).toHaveCount(1);
  await expect(groupRows(page).first()).toContainText("agent:sample-b-driver");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(groupRows(page)).toHaveCount(4);
});

test("a job opens with each claim beside the checks the Worker ran on it, then the touch log", async ({ page }) => {
  await page.goto(`${urlOf("claims")}?job=${DONE}`);
  await expect(page.getByRole("heading", { level: 2, name: `Job ${DONE}` })).toBeVisible();
  const complete = page.locator("[data-claim='3']");
  await expect(complete).toContainText("complete");
  await expect(complete).toContainText("PRs opened 1");
  await expect(complete).toContainText("files touched 1");
  const commits = complete.locator("tr[data-row]").filter({ hasText: "commits" });
  await expect(commits.locator('td[data-label="Claimed"]')).toHaveText("3");
  await expect(commits.locator('td[data-label="Verified"]')).toHaveText("2");
  await expect(commits.locator('td[data-label="Agreement"]')).toContainText("disagree");
  // Nothing claimed about CI: shown as not stated, never as a zero or a pass.
  const ci = complete.locator("tr[data-row]").filter({ hasText: "ci_green" });
  await expect(ci.locator('td[data-label="Claimed"]')).toHaveText("not stated");
  await expect(ci.locator('td[data-label="Verified"]')).toHaveText("not checked");
  // The block before it is a claim with no check.
  await expect(page.locator("[data-claim='2']")).toContainText("nothing is verified until the job ends");
  const touches = page.locator("main section").filter({ has: page.getByRole("heading", { level: 2, name: "Touch log" }) }).locator("tr[data-row]");
  await expect(touches).toHaveCount(2);
  await expect(touches.nth(0)).toContainText("gate");
  await expect(touches.nth(0).locator('td[data-label="Waited"]')).toHaveText("no wait");
  await expect(touches.nth(1)).toContainText("approval");
  await expect(touches.nth(1).locator('td[data-label="Waited"]')).toHaveText("55m");
  await page.getByRole("button", { name: "Close job", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: `Job ${DONE}` })).toHaveCount(0);
  await expect(page).toHaveURL(/\/claims$/);
});

test("a job id typed into the form opens it, and an unknown one shows the server's refusal", async ({ page }) => {
  await visit(page, "claims");
  await page.getByLabel("Job id", { exact: true }).fill(BLOCKED);
  await page.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: `Job ${BLOCKED}` })).toBeVisible();
  await expect(page.getByText("No outcome recorded")).toBeVisible();
  await page.getByLabel("Job id", { exact: true }).fill("job_000000000000");
  await page.getByRole("button", { name: "Open job", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 404");
});

test("an open job does not scroll sideways at 1024 px", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${urlOf("claims")}?job=${DONE}`);
  await expect(page.getByRole("heading", { level: 2, name: `Job ${DONE}` })).toBeVisible();
  expectNoSideways(await measure(page), "Claims with a job open at 1024");
});
