import { expect, test } from "@playwright/test";
import { visit } from "./views.ts";

// The frame and words of the Portal UX audit (2026-10): M9, the risky buttons apart from
// the safe ones; m4, secondary text 13 px at the least on a phone; m5, whole rows as tap
// targets; m10, the deploy timeline reached and scrolled from the keyboard. Ids are the
// sample feed's.

const BLOCKED = "job_7c1e44b0a912";

test("a blocked job's drawer has one primary action, the rest under More actions, and Mark failed alone under Danger", async ({ page }) => {
  await page.goto(`queue/job/${BLOCKED}`);
  const drawer = page.locator("dialog.drawer[open]");
  const controls = drawer.locator("[data-job-controls]");
  await expect(controls.locator(".btn.primary")).toHaveCount(1);
  await expect(controls.locator(".btn.primary")).toHaveText("Resume");
  // Close as shipped waits behind More actions.
  const more = controls.locator("details.more-actions");
  await expect(more.getByRole("button", { name: "Close as shipped" })).toBeHidden();
  await more.getByText("More actions").click();
  await expect(more.getByRole("button", { name: "Close as shipped" })).toBeVisible();
  // Mark failed is the Danger area's only button, and not in the row with Resume.
  const danger = controls.getByRole("group", { name: "Danger" });
  await expect(danger.getByRole("button")).toHaveText(["Mark failed"]);
  const resumeRow = controls.locator(".toolbar").filter({ has: page.getByRole("button", { name: "Resume", exact: true }) });
  await expect(resumeRow.getByRole("button", { name: "Mark failed" })).toHaveCount(0);
});

test("a CI run is opened by its whole row, not a 20 px link", async ({ page }) => {
  await page.goto("./health?tab=ci");
  const row = page.locator("main #ci tbody tr.click").first();
  await expect(row).toBeVisible();
  const link = row.locator("a.stretch");
  await expect(link).toHaveAttribute("href", /^https:\/\/github\.com\//);
  // The link's hit area is the row: a click at the row's left edge lands on it.
  const box = (await row.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("a")?.className ?? "", [box.x + 8, box.y + box.height / 2]);
  expect(hit).toContain("stretch");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("the deploy timeline, wider than the phone, is reached with Tab and scrolled with the arrow keys", async ({ page }) => {
    await page.goto("./health?tab=deploys");
    const scroller = page.getByRole("region", { name: "Timeline, scrolls sideways" });
    await expect(scroller).toBeVisible();
    await expect(scroller).toHaveAttribute("tabindex", "0");
    const wide = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(wide).toBe(true);
    await scroller.focus();
    await expect(scroller).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });

  for (const view of ["needs", "health", "queue", "prs", "activity"] as const) {
    test(`no secondary text on ${view} is under 13 px`, async ({ page }) => {
      await visit(page, view);
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>("main *")) {
          if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest(".sr-only, svg, [hidden]")) continue;
          const px = parseFloat(getComputedStyle(el).fontSize);
          // 0 px is a word hidden on purpose, its glyph kept (a Problems row's kind).
          if (px > 0 && px < 13) out.push(`${el.tagName.toLowerCase()}.${el.className} "${el.textContent!.trim().slice(0, 30)}" ${px}px`);
        }
        return out;
      });
      expect(small).toEqual([]);
    });
  }
});
