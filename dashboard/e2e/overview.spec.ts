import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { visit } from "./views.ts";

// Health's summary (the Overview's tiles, folded into Health on 2026-10-09) and the layout of PR 3 (capsid/research/audit-ui-patterns.md,
// rulings 1 to 4 and 10; capsid/research/design-portal-linear.md D3 and D20).
// Feeds are reshaped in the browser, the way the audit measured the live counts.

const DAY = 86_400_000;

// Rewrites the feed on its way to the app.
async function reshape(page: Page, fn: (f: OpsFeed) => void): Promise<void> {
  await page.route("**/portal/api/ops", async (route) => {
    const res = await route.fetch();
    const feed = (await res.json()) as OpsFeed;
    fn(feed);
    await route.fulfill({ response: res, json: feed });
  });
}

// Four pull requests of one repo awaiting the seat.
function fourPrs(f: OpsFeed): void {
  const a0 = f.live.awaiting_seat[0]!;
  f.live.awaiting_seat = [29, 30, 31, 32].map((n) => ({ ...a0, repo: "example-org/sample-info", namespace: "sample-info", number: n }));
  // The canon proposals' row is newer than the PRs' and would push their row behind
  // "N more warnings".
  f.live.canon_proposals = [];
}

const attention = (page: Page) => page.locator("main section.attention");

// ---- D3: tiles never truncate ------------------------------------------------------------

for (const width of [1440, 1100, 400]) {
  test(`D3: at ${width} px no tile cuts, clips or spills its text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await visit(page, "health");
    const r = await page.evaluate(() => {
      const bad: string[] = [];
      let checked = 0;
      const tiles = [...document.querySelectorAll<HTMLElement>("main .tiles .tile")];
      for (const tile of tiles) {
        const box = tile.getBoundingClientRect();
        for (const el of [tile, ...tile.querySelectorAll<HTMLElement>("*")]) {
          checked++;
          const cs = getComputedStyle(el);
          const name = `${el.className || el.tagName} in "${tile.innerText.replace(/\s+/g, " ")}"`;
          if (cs.textOverflow === "ellipsis") bad.push(`${name}: text-overflow ellipsis`);
          // Inline boxes report no scroll or client width; a block that does must fit.
          if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth) bad.push(`${name}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
          if (el === tile) continue;
          const b = el.getBoundingClientRect();
          if (b.left < box.left - 0.5 || b.right > box.right + 0.5 || b.top < box.top - 0.5 || b.bottom > box.bottom + 0.5) bad.push(`${name}: outside its tile`);
        }
      }
      return { tiles: tiles.length, checked, bad };
    });
    expect(r.tiles).toBe(5);
    expect(r.checked).toBeGreaterThan(5 * 4);
    expect(r.bad).toEqual([]);
  });
}

test("each tile is a link to its page or section", async ({ page }) => {
  await visit(page, "health");
  const tiles = page.locator("main .tiles a.tile");
  await expect(tiles).toHaveCount(5);
  // A link to assistive technology too, not only in the markup.
  await expect(page.locator("main .tiles").getByRole("link")).toHaveCount(5);
  await expect(tiles.filter({ hasText: "Blocked on you" })).toHaveAttribute("href", "/portal/queue");
  await expect(tiles.filter({ hasText: "Open findings" })).toHaveAttribute("href", "#incidents");
  await tiles.filter({ hasText: "Blocked on you" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
});

// ---- ruling 2: no Queue panel; the attention list is on Needs you -------------------------

test("Health has its five sections, no Queue panel and no attention list", async ({ page }) => {
  await visit(page, "health");
  // Its sections are there, so the absence below is not an empty page.
  await expect(page.locator("main h2.health-title")).toHaveText(["Sites", "Incidents", "Deploys", "Backups", "CI, default branches"]);
  // The Maintenance list's own rows (.mrow) are the daily pass's, not the Queue's.
  await expect(page.locator("main .qrow:not(.mrow)")).toHaveCount(0);
  await expect(page.locator("main section.attention")).toHaveCount(0);
});

// ---- ruling 3: grouping and notices -------------------------------------------------------

test("four pull requests waiting are four rows in Waiting for you, each with its own Approve and Close, and none in Problems", async ({ page }) => {
  await reshape(page, (f) => {
    fourPrs(f);
    const app = f.live.inbox.apps.find((a) => a.namespace === "sample-c")!;
    app.items = [29, 30, 31, 32].map((n) => ({ title: `PR #${n} waits for you`, kind: "pr" as const, link: `https://github.com/example-org/sample-info/pull/${n}`, since: f.live.generated }));
  });
  await visit(page, "needs");
  const prs = page.locator('[data-group="w-prs"]');
  await expect(prs.locator(".wrow")).toHaveCount(4);
  for (const n of [29, 30, 31, 32]) {
    await expect(prs.getByRole("button", { name: `Approve example-org/sample-info #${n}`, exact: true })).toBeVisible();
    await expect(prs.getByRole("button", { name: `Close example-org/sample-info #${n}`, exact: true })).toBeVisible();
  }
  await expect(attention(page).getByText(/await the seat/)).toHaveCount(0);
});

test("the blocked jobs are rows in Waiting for you, and none of them is repeated in Problems", async ({ page }) => {
  await visit(page, "needs");
  await expect(page.locator('[data-group="w-jobs"] .wrow')).toHaveCount(3);
  await expect(attention(page).getByText(/jobs? (is|are) waiting on you/)).toHaveCount(0);
});

const NOTICE_TITLES = [/no Cloudflare data/, /could not run/, /could not be read/, /Site map drift/, /silent/];

test("notices are one row, closed, at the foot; the problems hold none of them", async ({ page }) => {
  await visit(page, "needs");
  const problems = attention(page).locator(".att-list");
  const titles = await problems.locator(".att-row b, .att-row .rowlink").allInnerTexts();
  expect(titles.length).toBeGreaterThanOrEqual(5);
  for (const re of NOTICE_TITLES) expect(titles.filter((t) => re.test(t)), `${re} is among the problems`).toEqual([]);
  await expect(problems.locator(".st.nodata")).toHaveCount(0);
  const toggle = attention(page).locator(".notices").getByRole("button", { name: /^\d+ notices?$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#att-notices")).toBeHidden();
  await toggle.click();
  const notices = page.locator("#att-notices .att-child");
  await expect(notices).toHaveCount(Number((await toggle.innerText()).split(" ")[0]));
  for (const re of NOTICE_TITLES) await expect(notices.filter({ hasText: re }).first()).toBeVisible();
});

test("with no problems it says all clear, and the notices row stays under it", async ({ page }) => {
  await reshape(page, (f) => {
    const snap = f.snapshot!;
    for (const s of snap.sites) (s.state = "ok"), (s.ring = s.ring.replace(/0/g, "1"));
    delete snap.health!.backup.warning;
    snap.health!.status = "ok";
    snap.mirror = { newest_dump: f.live.generated, last_run: { at: f.live.generated, conclusion: "success", url: null } };
    snap.ci = snap.ci.map((c) => (c.latest ? { ...c, latest: { ...c.latest, conclusion: "success" } } : c));
    f.live.jobs = f.live.jobs.filter((j) => j.status !== "blocked" && j.status !== "claimed");
    f.live.awaiting_seat = [];
    f.live.canon_proposals = [];
    // Session incidents are problems too (Problems lists them).
    f.live.sessions = f.live.sessions.map((s) => ({ ...s, incident: null }));
    // A failing or quiet scheduled task is a problem too (src/task-runs.ts).
    for (const t of f.scheduled.tasks ?? []) if (t.flag !== "never") t.flag = null;
  });
  await visit(page, "needs");
  await expect(attention(page).getByText("No problems.")).toBeVisible();
  await expect(attention(page).locator(".att-list")).toHaveCount(0);
  await expect(attention(page).locator(".notices").getByRole("button", { name: /^\d+ notices?$/ })).toHaveAttribute("aria-expanded", "false");
});

// ---- ruling 10: blocked order and closed finished groups ----------------------------------
// The list's old Stale group is folded into the Stale jobs panel (2026-10-09): these
// reshaped jobs are not among the panel's rows, so all six stay in Blocked.

test("the Queue orders blocked jobs by priority then newest, the ones blocked over 7 days after, and starts Done and Failed closed", async ({ page }) => {
  await reshape(page, (f) => {
    const now = Date.parse(f.live.generated);
    const base = f.live.jobs.find((j) => j.status === "blocked")!;
    const at = (d: number) => new Date(now - d * DAY).toISOString();
    const blocked = [
      { title: "Low, one day", priority: 0, updated_at: at(1) },
      { title: "High, three days", priority: 2, updated_at: at(3) },
      { title: "Low, half a day", priority: 0, updated_at: at(0.5) },
      { title: "High, two days", priority: 2, updated_at: at(2) },
      { title: "Top, nine days", priority: 5, updated_at: at(9) },
      { title: "Low, twelve days", priority: 0, updated_at: at(12) },
    ].map((x, i) => ({ ...base, ...x, id: `job_00000000000${i}`, finding: null }));
    f.live.jobs = [...blocked, ...f.live.jobs.filter((j) => j.status !== "blocked")];
  });
  await visit(page, "queue");
  const group = (id: string) => page.locator(`main .qgroup[data-group="${id}"]`);
  await expect(group("blocked").locator(".qrow b")).toHaveText(["High, two days", "High, three days", "Low, half a day", "Low, one day", "Top, nine days", "Low, twelve days"]);
  expect(await page.locator("main #jobs .qgroup").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group))).toEqual(["blocked", "running", "queued", "parked", "done", "failed"]);
  for (const id of ["done", "failed"]) {
    const toggle = group(id).getByRole("button");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(group(id).locator(".qrow")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(group(id).locator(".qrow").first()).toBeVisible();
  }
});

// ---- ruling 4: the anchor bar -------------------------------------------------------------

test("Health gets the anchor bar, naming its sections and not their panels, with links that follow the scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await visit(page, "health");
  const bar = page.getByRole("navigation", { name: "On this page" });
  await expect(bar).toBeVisible();
  const links = bar.getByRole("link");
  await expect(links).toHaveText(["Summary", "Sites", "Incidents", "Deploys", "Backups", "CI"]);
  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(["#summary", "#sites", "#incidents", "#deploys", "#backups", "#ci"]);
  await expect(links.nth(0)).toHaveAttribute("aria-current", "location");
  // The scroller keeps a focused row clear of the bar.
  const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop));
  const barH = await bar.evaluate((b) => b.getBoundingClientRect().height);
  expect(pad).toBeGreaterThanOrEqual(barH);
  // Scrolled to the foot, the last section is current.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(links.nth(5)).toHaveAttribute("aria-current", "location");
  await expect(links.nth(0)).not.toHaveAttribute("aria-current", /.+/);
  // A click jumps there and marks it.
  await links.nth(3).click();
  await expect(links.nth(3)).toHaveAttribute("aria-current", "location");
  await expect.poll(() => page.locator("#deploys").evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThanOrEqual(Math.ceil(pad) + 1);
  expect(new URL(page.url()).hash).toBe("#deploys");
});

test("an old view's address is replaced by the page, tab or section that holds it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("./deploys");
  await expect(page.getByRole("heading", { level: 1, name: "Health" })).toBeVisible();
  await expect(page).toHaveURL(/\/health#deploys$/);
  // Scrolled to the section once it is drawn.
  await expect.poll(() => page.locator("#deploys").evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThan(200);
  await page.goto("./ci");
  await expect(page.getByRole("heading", { level: 1, name: "Pull requests" })).toBeVisible();
  await expect(page).toHaveURL(/\/prs$/);
  await page.goto("./claims?namespace=sample-b");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?tab=claims&namespace=sample-b$/);
  await expect(page.getByRole("button", { name: "Claims", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("./namespaces");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings#automation$/);
  // A drawer over an old view stays open, over the page that holds it.
  await page.goto("./sites/site/Sample%20A");
  await expect(page).toHaveURL(/\/health\/site\/Sample%20A$/);
  await expect(page.locator("dialog.drawer[open]")).toBeVisible();
});

