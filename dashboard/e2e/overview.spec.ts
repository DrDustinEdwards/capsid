import { expect, test, type Page } from "@playwright/test";
import type { OpsFeed } from "../src/types.ts";
import { ALL_VIEWS, VIEW_COUNT, visit } from "./views.ts";

// The restructured Overview and the layout of PR 3 (capsid/research/audit-ui-patterns.md,
// rulings 1 to 4 and 10; capsid/research/design-portal-linear.md D3, D13, D18, D20).
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
}

const attention = (page: Page) => page.locator("main section.attention");

// ---- D3: tiles never truncate ------------------------------------------------------------

for (const width of [1440, 1100, 400]) {
  test(`D3: at ${width} px no tile cuts, clips or spills its text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await visit(page, "overview");
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
    expect(r.tiles).toBe(6);
    expect(r.checked).toBeGreaterThan(6 * 4);
    expect(r.bad).toEqual([]);
  });
}

test("each tile is a link to its view", async ({ page }) => {
  await visit(page, "overview");
  const tiles = page.locator("main .tiles a.tile");
  await expect(tiles).toHaveCount(6);
  await expect(tiles.filter({ hasText: "Blocked on you" })).toHaveAttribute("href", "/portal/queue");
  await tiles.filter({ hasText: "Open findings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Incidents" })).toBeVisible();
});

// ---- ruling 2: no Queue and no Incidents panel ------------------------------------------

test("the Overview has no Queue panel and no Incidents panel", async ({ page }) => {
  await visit(page, "overview");
  const h2 = await page.locator("main h2").allTextContents();
  // Its sections are there, so the absence below is not an empty page.
  expect(h2).toEqual(["Needs attention", "Sites", "Deploys and downtime, 7 days"]);
  await expect(page.locator("main .qrow, main .frow")).toHaveCount(0);
});

// ---- ruling 3: grouping and notices -------------------------------------------------------

test("four pull requests of one repo are one row that opens in place to four", async ({ page }) => {
  await reshape(page, fourPrs);
  await visit(page, "overview");
  const rows = attention(page).locator(".att-row").filter({ hasText: /awaits? the seat/ });
  await expect(rows).toHaveCount(1);
  const toggle = rows.getByRole("button", { name: "4 pull requests await the seat" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const kids = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  await expect(kids).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(kids.locator(".att-child")).toHaveCount(4);
  for (const n of [29, 30, 31, 32]) await expect(kids.getByText(`example-org/sample-info #${n} awaits the seat`)).toBeVisible();
  await expect(kids.getByRole("link", { name: "Open CI and merges" })).toBeVisible();
  // Enter on the focused button closes it again.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(kids).toBeHidden();
  // A child opens what it names.
  await toggle.click();
  await kids.locator(".att-child").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "CI and merges" })).toBeVisible();
});

test("the blocked jobs are one row whose children are the jobs, then a link to the Queue", async ({ page }) => {
  await visit(page, "overview");
  const toggle = attention(page).getByRole("button", { name: "3 jobs are waiting on you" });
  await toggle.click();
  const kids = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
  await expect(kids.locator(".att-child")).toHaveCount(3);
  await expect(kids.getByRole("link", { name: "Open Queue" })).toHaveAttribute("href", "/portal/queue");
  await kids.locator(".att-child").first().click();
  await expect(page.locator("aside.drawer.on")).toBeVisible();
});

const NOTICE_TITLES = [/no Cloudflare data/, /could not run/, /could not be read/, /Site map drift/, /silent/];

test("notices are one row, closed, at the foot; the problems hold none of them", async ({ page }) => {
  await visit(page, "overview");
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
    f.live.loop.budget.exceeded = false;
  });
  await visit(page, "overview");
  await expect(attention(page).getByText("All clear. Nothing needs you.")).toBeVisible();
  await expect(attention(page).locator(".att-list")).toHaveCount(0);
  await expect(attention(page).locator(".notices").getByRole("button", { name: /^\d+ notices?$/ })).toHaveAttribute("aria-expanded", "false");
});

// ---- ruling 10: blocked order, Stale, and closed finished groups ----------------------------

test("the Queue orders blocked jobs by priority then newest, puts the stale ones after, and starts Done and Failed closed", async ({ page }) => {
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
  await expect(group("blocked").locator(".qrow b")).toHaveText(["High, two days", "High, three days", "Low, half a day", "Low, one day"]);
  await expect(group("stale").locator("h3")).toContainText("Stale, blocked over 7 days");
  await expect(group("stale").locator(".qrow b")).toHaveText(["Top, nine days", "Low, twelve days"]);
  // Stale comes right after Blocked.
  expect(await page.locator("main .qgroup").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group))).toEqual(["blocked", "stale", "running", "queued", "done", "failed"]);
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

test("the Overview has no anchor bar at 1920 x 1080, with the live-shaped counts", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await reshape(page, (f) => {
    fourPrs(f);
    const blocked = f.live.jobs.filter((j) => j.status === "blocked");
    const queued = f.live.jobs.filter((j) => j.status === "queued");
    const grow = (list: typeof blocked, n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ ...list[i % list.length]!, id: `job_${tag}${String(i).padStart(10, "0")}` }));
    f.live.jobs = [...grow(blocked, 30, "b"), ...grow(queued, 17, "q"), ...f.live.jobs.filter((j) => j.status !== "blocked" && j.status !== "queued")];
  });
  await visit(page, "overview");
  // Four sections, so only the height keeps it away.
  await expect(page.locator("main [data-section][id]")).toHaveCount(4);
  const h = await page.locator("main").evaluate((m) => ({ scroll: m.scrollHeight, client: m.clientHeight }));
  expect(h.scroll).toBeLessThanOrEqual(2 * h.client);
  await expect(page.getByRole("navigation", { name: "On this page" })).toHaveCount(0);
});

test("a view with three sections taller than two screens gets the anchor bar, with links that follow the scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await visit(page, "deploys");
  const bar = page.getByRole("navigation", { name: "On this page" });
  await expect(bar).toBeVisible();
  const links = bar.getByRole("link");
  await expect(links).toHaveText(["Timeline", "Every deploy", "No deploy data"]);
  expect(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(["#timeline", "#every-deploy", "#no-deploy-data"]);
  await expect(links.nth(0)).toHaveAttribute("aria-current", "location");
  // The scroller keeps a focused row clear of the bar.
  const pad = await page.locator("main").evaluate((m) => parseFloat(getComputedStyle(m).scrollPaddingTop));
  const barH = await bar.evaluate((b) => b.getBoundingClientRect().height);
  expect(pad).toBeGreaterThanOrEqual(barH);
  // Scrolled to the foot, the last section is current.
  await page.locator("main").evaluate((m) => m.scrollTo(0, m.scrollHeight));
  await expect(links.nth(2)).toHaveAttribute("aria-current", "location");
  await expect(links.nth(0)).not.toHaveAttribute("aria-current", /.+/);
  // A click jumps there and marks it.
  await links.nth(1).click();
  await expect(links.nth(1)).toHaveAttribute("aria-current", "location");
  await expect.poll(() => page.locator("#every-deploy").evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest("main")!.getBoundingClientRect().top))).toBeLessThanOrEqual(Math.ceil(pad) + 1);
  expect(new URL(page.url()).hash).toBe("#every-deploy");
  // In a window tall enough, the same view does without it.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await expect(bar).toHaveCount(0);
});

// ---- D13 and D18 ---------------------------------------------------------------------------

test("D13: every view's head is its h1 alone, 18 px, and the shortcut sheet says what each view is for", async ({ page }) => {
  test.setTimeout(10_000 * VIEW_COUNT);
  const found: string[] = [];
  let seen = 0;
  for (const v of ALL_VIEWS) {
    await visit(page, v.id);
    const head = await page.locator("main .pagehead").evaluate((el) => ({ children: [...el.children].map((c) => c.tagName.toLowerCase()), size: getComputedStyle(el.querySelector("h1")!).fontSize, weight: getComputedStyle(el.querySelector("h1")!).fontWeight }));
    if (head.children.join() !== "h1") found.push(`${v.label}: head holds ${head.children.join(", ")}`);
    if (head.size !== "18px" || head.weight !== "600") found.push(`${v.label}: h1 ${head.size} / ${head.weight}`);
    const next = await page.locator("main h1").evaluate((h) => h.parentElement?.nextElementSibling?.tagName.toLowerCase() ?? "");
    if (next === "p") found.push(`${v.label}: a paragraph under the heading`);
    seen++;
  }
  expect(seen).toBe(VIEW_COUNT);
  expect(found).toEqual([]);
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard" });
  await expect(help.getByText("From Cloudflare's own record, so a hand-run wrangler deploy shows up too.")).toBeVisible();
  await expect(help.locator(".about")).toHaveCount(VIEW_COUNT - 1);
});

test("D18: a cell with no data says two words, its reason on hover; the backup column says once who reports one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await visit(page, "sites");
  const cells = page.locator('main table.fleet td[data-label="Backup age"]');
  const n = await cells.count();
  expect(n).toBe(8);
  const nodata = cells.locator(".st.nodata");
  // Every site but Capsid; the sample feed has no Capsid row.
  await expect(nodata).toHaveCount(n);
  for (const c of await nodata.all()) {
    // What is seen: the words, not the reason kept for screen readers (.sr-only).
    const seen = await c.evaluate((el) => [...el.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("sr-only"))).map((n) => n.textContent).join("").trim());
    expect(seen).toBe("No data");
    await expect(c).toHaveAttribute("data-tip", "not reported by the site");
  }
  await expect(page.locator("main table.fleet th").filter({ hasText: "Backup age" })).toContainText("only Capsid reports one");
  // No cell in the fleet writes its reason out.
  await expect(page.locator("main table.fleet .nodata-cell")).toHaveCount(0);
  // The panel does: Sample G's has the full sentence.
  await page.locator('main table.fleet tr[data-open="site:Sample G"]').click();
  await expect(page.locator("aside.drawer.on")).toContainText("No data: Cloudflare read not configured");
});
