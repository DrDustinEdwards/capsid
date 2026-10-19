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

// Nothing wrong and nothing waiting: every site up, both backups fresh, CI green.
function allClear(f: OpsFeed): void {
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
}

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
    expect(r.tiles).toBe(4);
    expect(r.checked).toBeGreaterThan(4 * 4);
    expect(r.bad).toEqual([]);
  });
}

test("each tile is a link to its tab", async ({ page }) => {
  await visit(page, "health");
  const tiles = page.locator("main .tiles a.tile");
  await expect(tiles).toHaveCount(4);
  // A link to assistive technology too, not only in the markup.
  await expect(page.locator("main .tiles").getByRole("link")).toHaveCount(4);
  await expect(tiles.filter({ hasText: "Sites up" })).toHaveAttribute("href", "/portal/health?tab=sites");
  await expect(tiles.filter({ hasText: "Open findings" })).toHaveAttribute("href", "/portal/health?tab=problems");
  await expect(tiles.filter({ hasText: "Mirror" })).toHaveAttribute("href", "/portal/health?tab=backups");
  await tiles.filter({ hasText: "Open findings" }).click();
  await expect(page).toHaveURL(/\/health\?tab=problems$/);
  await expect(page.locator("#problems").getByRole("heading", { level: 2, name: "Findings" })).toBeVisible();
});

// UX audit m3: the primary backup and the off-account mirror are two tiles, so a stale
// mirror (10 days in the sample) does not turn a good backup red.
test("Backup and Mirror are separate tiles, and only the stale mirror is critical", async ({ page }) => {
  await visit(page, "health");
  const tile = (label: string) => page.locator("main .tiles a.tile").filter({ has: page.locator(".l", { hasText: new RegExp(`^${label}$`) }) });
  await expect(tile("Backup")).toHaveClass(/\bok\b/);
  await expect(tile("Backup")).toContainText("last good dump");
  await expect(tile("Mirror")).toHaveClass(/\bcrit\b/);
  await expect(tile("Mirror")).toContainText("10d");
  // What waits on you is counted on Needs you only (m2).
  await expect(page.locator("main .tiles").getByText("Blocked on you")).toHaveCount(0);
});

// ---- UX audit M1: one line first, then tabs ------------------------------------------------

test("Health opens with a one-line verdict naming its problems as links, then the tiles and five tabs", async ({ page }) => {
  await visit(page, "health");
  const verdict = page.locator("main [data-verdict]");
  await expect(verdict).toHaveAttribute("data-verdict", "problems");
  await expect(verdict).toContainText(/^\d+ problems:/);
  await expect(verdict.getByRole("link", { name: /Off-account mirror has not landed a dump/ })).toHaveAttribute("href", "/portal/health?tab=backups");
  await expect(verdict.getByRole("button", { name: /^\d+ more$/ })).toBeVisible();
  // Verdict, tiles, tabs, in that order.
  const order = await page.evaluate(() => ["[data-verdict]", ".tiles", "nav[aria-label='Health']"].map((s) => Math.round(document.querySelector(`main ${s}`)!.getBoundingClientRect().top)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  const tabs = page.getByRole("navigation", { name: "Health", exact: true }).getByRole("link");
  await expect(tabs).toHaveText(["Sites", "Problems", "Deploys", "Backups", "CI"]);
  await expect(tabs.first()).toHaveAttribute("aria-current", "page");
  // One tab's content at a time: the fleet, and no deploy timeline.
  await expect(page.locator("main table.fleet")).toHaveCount(1);
  await expect(page.locator("main #deploys")).toHaveCount(0);
  // No Queue panel and no attention list on Health.
  await expect(page.locator("main .qrow:not(.mrow)")).toHaveCount(0);
  await expect(page.locator("main section.attention")).toHaveCount(0);
  // "N more" goes to the whole list on Needs you.
  await verdict.getByRole("button", { name: /^\d+ more$/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Needs you" })).toBeVisible();
  await expect(attention(page)).toBeVisible();
});

test("the verdict says All good when nothing is wrong", async ({ page }) => {
  await reshape(page, allClear);
  await visit(page, "health");
  const verdict = page.locator("main [data-verdict]");
  await expect(verdict).toHaveAttribute("data-verdict", "ok");
  await expect(verdict).toContainText("All good");
  await expect(verdict.getByRole("link")).toHaveCount(0);
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
  await reshape(page, allClear);
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

// ---- the tabs: links in the address ---------------------------------------------------------

test("a Health tab is a link: it changes the address, shows its own content, and Back returns", async ({ page }) => {
  await visit(page, "health");
  const tabs = page.getByRole("navigation", { name: "Health", exact: true });
  await tabs.getByRole("link", { name: "Deploys" }).click();
  await expect(page).toHaveURL(/\/health\?tab=deploys$/);
  await expect(tabs.getByRole("link", { name: "Deploys" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "Sites" })).not.toHaveAttribute("aria-current", /.+/);
  await expect(page.locator("main #deploys")).toBeVisible();
  await expect(page.locator("main table.fleet")).toHaveCount(0);
  // Keyboard: each tab is a stop, and Enter follows it.
  await tabs.getByRole("link", { name: "CI" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/health\?tab=ci$/);
  await expect(page.locator("main #ci").getByRole("heading", { level: 2, name: "Default branches" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/health\?tab=deploys$/);
});

test("an old section anchor opens its tab", async ({ page }) => {
  const tabs = page.getByRole("navigation", { name: "Health", exact: true });
  await page.goto("./health#backups");
  await expect(tabs.getByRole("link", { name: "Backups" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#backup-slots")).toBeVisible();
  await page.goto("./health#incidents");
  await expect(tabs.getByRole("link", { name: "Problems" })).toHaveAttribute("aria-current", "page");
});

test("an old view's address is replaced by the page, tab or section that holds it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("./deploys");
  await expect(page.getByRole("heading", { level: 1, name: "Health" })).toBeVisible();
  await expect(page).toHaveURL(/\/health\?tab=deploys$/);
  await expect(page.locator("main #deploys")).toBeVisible();
  await page.goto("./incidents?ns=watcher");
  await expect(page).toHaveURL(/\/health\?tab=problems&ns=watcher$/);
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

