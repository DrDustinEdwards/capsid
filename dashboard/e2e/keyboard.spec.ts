import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// j and k move a selection through the rows, Enter opens the selected row, Esc closes it,
// and the selection can be seen: the row's background changes and it carries a ring at
// 3:1 against that background (design-portal-linear.md D8). Before this the selected
// row differed from the surface by 1.06:1.

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const lum = (c: [number, number, number]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const rgb = (s: string): [number, number, number] => {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`no colour in "${s}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

async function selected(page: Page): Promise<{ index: number; title: string; bg: string; shadow: string; surface: string }> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("main [data-row]"));
    const index = rows.findIndex((r) => r.classList.contains("sel"));
    const row = rows[index];
    const s = row ? getComputedStyle(row) : null;
    return {
      index,
      title: row?.querySelector("b")?.textContent ?? "",
      bg: s?.backgroundColor ?? "",
      shadow: s?.boxShadow ?? "",
      surface: getComputedStyle(document.querySelector(".panel")!).backgroundColor,
    };
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("j and k move the selection, Enter opens the row, Esc closes it", async ({ page }) => {
      await visit(page, "queue");
      expect((await selected(page)).index).toBe(-1);
      await page.keyboard.press("j");
      expect((await selected(page)).index).toBe(0);
      await page.keyboard.press("j");
      const second = await selected(page);
      expect(second.index).toBe(1);
      expect(second.title).not.toBe("");
      await page.keyboard.press("k");
      expect((await selected(page)).index).toBe(0);
      const first = await selected(page);
      await page.keyboard.press("Enter");
      const drawer = page.locator("aside.drawer.on");
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute("aria-hidden", "false");
      await expect(drawer.locator("h2")).toHaveText(first.title);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      expect((await selected(page)).index, "Esc keeps the selection").toBe(0);
    });

    test("the selected row can be seen: a changed background and a ring at 3:1", async ({ page }) => {
      await visit(page, "queue");
      await page.keyboard.press("j");
      const s = await selected(page);
      expect(s.index).toBe(0);
      expect(s.bg, "the selected row's background differs from the panel's").not.toBe(s.surface);
      expect(s.shadow, "the selected row carries an inset ring").toContain("inset");
      expect(ratio(rgb(s.shadow), rgb(s.bg)), `ring ${s.shadow} on ${s.bg}`).toBeGreaterThanOrEqual(3);
    });
  });
}
