import { expect, test, type Page } from "@playwright/test";
import { ALL_VIEWS, VIEW_COUNT, visit } from "./views.ts";

// Type and rows (capsid/research/design-portal-linear.md, D1, D2, D6, D9, D10, D11), as
// the browser lays them out with the sample feed. Every check counts what it looked at,
// so a selector that stops matching fails rather than passing on nothing.

const LIST_ROWS = "main .att-row, main .qrow, main .frow";
// The Overview no longer carries the Queue and Incidents panels (the UI audit's ruling
// 2), so their rows are measured on their own views. Rows of a closed group are not
// drawn. With the sample feed: 9 attention rows (8 problems, two of them session
// incidents, and the notices row), 13
// queue rows (Stale jobs 2, Blocked 2, Stale 1, Running 1, Queued 4, live sessions 3)
// and 7 incident rows. The Stale jobs panel reads its own route, so the Queue is
// measured once its rows have arrived.
const LIST_VIEWS = ["overview", "queue", "incidents"] as const;
const LIST_COUNT = 29;

// fn's results on each list view, in turn.
async function acrossLists<T>(page: Page, fn: () => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const v of LIST_VIEWS) {
    await visit(page, v);
    if (v === "queue") await page.locator("main [data-rule]").first().waitFor();
    out.push(...(await fn()));
  }
  return out;
}

// Every element with its own visible text, in main, the top bar and the menu.
async function textElements(page: Page): Promise<Array<{ text: string; size: number; family: string; tag: string }>> {
  return page.evaluate(() => {
    const out: Array<{ text: string; size: number; family: string; tag: string }> = [];
    for (const root of document.querySelectorAll("main, .cap-admin-bar, nav.cap-admin-menu")) {
      for (const el of root.querySelectorAll<Element>("*")) {
        const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
        if (!own) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        // Text hidden for screen readers only (.sr-only) is not set in any size a person sees.
        if (el.closest(".sr-only")) continue;
        out.push({ text: own, size: parseFloat(cs.fontSize), family: cs.fontFamily, tag: el.tagName.toLowerCase() });
      }
    }
    return out;
  });
}

test("D1: the body is 13 px and no visible text on any view is under 11 px", async ({ page }) => {
  test.setTimeout(10_000 * VIEW_COUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  let checked = 0;
  const small: string[] = [];
  for (const v of ALL_VIEWS) {
    await visit(page, v.id);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("13px");
    for (const t of await textElements(page)) {
      checked++;
      if (t.size < 11) small.push(`${v.label}: <${t.tag}> "${t.text.slice(0, 40)}" at ${t.size} px`);
    }
  }
  expect(checked).toBeGreaterThan(500);
  expect(small).toEqual([]);
});

// Heights of every element a selector matches on a view.
function heights(page: Page, sel: string): Promise<number[]> {
  return page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(s)].map((e) => e.getBoundingClientRect().height), sel);
}

test("D2: two-line list rows are 47 px and one-line table rows about 34 px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await acrossLists(page, () => heights(page, LIST_ROWS));
  expect(rows.length).toBe(LIST_COUNT);
  expect(rows.filter((h) => Math.abs(h - 47) > 0.5)).toEqual([]);
  // The Activity table has one line in every cell.
  await visit(page, "activity");
  const table = await heights(page, "main table.list tbody tr");
  expect(table.length).toBeGreaterThanOrEqual(5);
  expect(table.filter((h) => h < 32.5 || h > 35)).toEqual([]);
});

test("D6: no rule between list rows; rules kept between table rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const lists = { n: 0, out: [] as string[] };
  for (const part of await acrossLists(page, async () => [
    await page.evaluate((sel) => {
      const out: string[] = [];
      let n = 0;
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        n++;
        const cs = getComputedStyle(el);
        const widths = [cs.borderTopWidth, cs.borderBottomWidth, cs.borderLeftWidth, cs.borderRightWidth];
        if (widths.some((w) => w !== "0px")) out.push(`${el.className}: borders ${widths.join(" ")}`);
        // The group around queue rows draws none either.
        const g = el.closest<HTMLElement>(".qgroup");
        if (g && getComputedStyle(g).borderBottomWidth !== "0px") out.push(`qgroup around ${el.className}: bottom border`);
      }
      return { n, out };
    }, LIST_ROWS),
  ])) {
    lists.n += part.n;
    lists.out.push(...part.out);
  }
  expect(lists.n).toBe(LIST_COUNT);
  expect(lists.out).toEqual([]);
  // The Overview's Sites table keeps a 1 px rule over each row.
  await visit(page, "overview");
  const brief = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main table.brief tbody td")].map((td) => getComputedStyle(td).borderTopWidth));
  expect(brief.length).toBe(40);
  expect(brief.filter((w) => w !== "1px")).toEqual([]);
  // The fleet table on Sites: rows other than the last keep a 1 px rule under each cell.
  await visit(page, "sites");
  const cells = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main table.fleet tbody tr:not(:last-child) > td")].map((td) => getComputedStyle(td).borderBottomWidth));
  expect(cells.length).toBeGreaterThan(20);
  expect(cells.filter((w) => w !== "1px")).toEqual([]);
});

test("D9: one status glyph per list row, and the red edge only on critical rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const rows = await acrossLists(page, () =>
    page.evaluate((sel) => {
      const crit = getComputedStyle(document.documentElement).getPropertyValue("--crit").trim();
      return [...document.querySelectorAll<HTMLElement>(sel)].map((el) => ({
        cls: el.className,
        glyphs: el.querySelectorAll("svg").length,
        // The glyph's own colour class, st.crit or the icon's colour: critical or not.
        critical: !!el.querySelector(".st.crit") || el.querySelector("svg")?.getAttribute("style")?.includes("var(--crit)") === true,
        shadow: getComputedStyle(el).boxShadow,
        crit,
      }));
    }, LIST_ROWS),
  );
  expect(rows.length).toBe(LIST_COUNT);
  expect(rows.filter((r) => r.glyphs !== 1).map((r) => `${r.cls}: ${r.glyphs} glyphs`)).toEqual([]);
  const critical = rows.filter((r) => r.critical);
  const other = rows.filter((r) => !r.critical);
  // The sample feed has both, so neither half passes on nothing.
  expect(critical.length).toBeGreaterThanOrEqual(3);
  expect(other.length).toBeGreaterThanOrEqual(10);
  // A 3 px inset edge on the left, and nothing on the rows that are not critical.
  // Computed, a shadow reads "<colour> 3px 0px 0px 0px inset".
  expect(critical.filter((r) => !/ 3px 0px 0px 0px inset/.test(r.shadow)).map((r) => `${r.cls}: ${r.shadow}`)).toEqual([]);
  expect(other.filter((r) => r.shadow !== "none").map((r) => `${r.cls}: ${r.shadow}`)).toEqual([]);
});

// Times, counts, percentages, sizes and HTTP codes: never set in the monospace face. A
// run of seven or more digits, or one with a leading zero, is an identifier (a short
// version id, a migration number), so the count pattern leaves it alone.
const NOT_AN_IDENTIFIER = [
  /\bago$/,
  /^in \d/,
  /^(0|[1-9][\d,]{0,5})(\.\d+)?\s*(ms|%|h|s|m|d|min|KB|MB)?$/,
  /^HTTP \d{3}$/,
  /^\d[\d.,]* (items?|blocked|running|queued|done|failed|merged)\b/,
  /^(lease|queued|waiting|done|failed|first seen)\b/,
];

test("D10: monospace only for identifiers, on every view", async ({ page }) => {
  test.setTimeout(10_000 * VIEW_COUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  let mono = 0;
  const wrong: string[] = [];
  for (const v of ALL_VIEWS) {
    await visit(page, v.id);
    for (const t of await textElements(page)) {
      if (!t.family.startsWith('"Martian Mono"')) continue;
      mono++;
      if (NOT_AN_IDENTIFIER.some((re) => re.test(t.text))) wrong.push(`${v.label}: "${t.text}" in <${t.tag}>`);
    }
  }
  // Identifiers are still set in it: namespaces, shas, ids, paths.
  expect(mono).toBeGreaterThan(50);
  expect(wrong).toEqual([]);
});

test("D11: list rows carry no job id or fingerprint; the drawer does", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const found: string[] = [];
  let rows = 0;
  for (const view of ["overview", "queue", "incidents"] as const) {
    await visit(page, view);
    if (view === "queue") await page.locator("main [data-rule]").first().waitFor();
    const res = await page.evaluate((sel) => {
      const out: string[] = [];
      const all = [...document.querySelectorAll<HTMLElement>(sel)];
      for (const el of all) {
        const text = el.innerText;
        if (/\bjob_[0-9a-f]{12}\b/.test(text)) out.push(`job id in "${text.replace(/\s+/g, " ").slice(0, 60)}"`);
        // The only monospace inside a row is the namespace.
        for (const m of el.querySelectorAll<HTMLElement>("*")) {
          if (getComputedStyle(m).fontFamily.startsWith('"Martian Mono"') && !m.matches(".ns") && m.innerText.trim()) out.push(`monospace "${m.innerText.trim().slice(0, 40)}" in a row`);
        }
      }
      return { n: all.length, out };
    }, LIST_ROWS);
    rows += res.n;
    found.push(...res.out.map((o) => `${view}: ${o}`));
  }
  expect(rows).toBe(LIST_COUNT);
  expect(found).toEqual([]);
  // The raw detail moved to the drawer: a watcher job's drawer shows its id and fingerprint.
  await visit(page, "incidents");
  // A watcher finding's row, not a live session's (those open a job with no finding).
  await page.locator('main .frow[data-open^="job:"]').filter({ hasNotText: "Session for" }).first().click();
  const drawer = page.locator("dialog.drawer[open]");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("header .mono")).toHaveText(/^job_[0-9a-f]{12}$/);
  await expect(drawer.locator("dt", { hasText: "Finding" })).toHaveCount(1);
});
