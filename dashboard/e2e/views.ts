import { expect, type Page } from "@playwright/test";
import { VIEWS, routePath, type ViewId } from "../src/app/ctx.ts";

// Every view the app registers, so a new view is covered without editing a test. The
// count is asserted where it is used: an empty list would otherwise pass vacuously.
export const ALL_VIEWS = VIEWS.map((v) => ({ id: v.id as ViewId, label: v.label as string }));
export const VIEW_COUNT = 10;

// Relative to the /console/app/ base URL.
export function urlOf(id: ViewId): string {
  return `.${routePath(id)}`;
}

// Opens a view and waits until its heading is up and nothing on it is still loading.
export async function visit(page: Page, id: ViewId): Promise<void> {
  const label = ALL_VIEWS.find((v) => v.id === id)!.label;
  await page.goto(urlOf(id));
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await expect(page.locator("main .loading")).toHaveCount(0);
}

export interface Overflow {
  doc: { scroll: number; client: number };
  main: { scroll: number; client: number } | null;
  // Elements inside main that scroll sideways (overflow-x auto or scroll, and wider
  // than their box).
  scrollers: string[];
}

export async function measure(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const main = document.querySelector("main");
    const scrollers: string[] = [];
    for (const el of main?.querySelectorAll<HTMLElement>("*") ?? []) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        scrollers.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, ".")} ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return {
      doc: { scroll: de.scrollWidth, client: de.clientWidth },
      main: main ? { scroll: main.scrollWidth, client: main.clientWidth } : null,
      scrollers,
    };
  });
}

export function expectNoSideways(o: Overflow, where: string): void {
  expect(o.doc.scroll, `${where}: the document scrolls sideways`).toBeLessThanOrEqual(o.doc.client);
  expect(o.main, `${where}: no main element`).not.toBeNull();
  expect(o.main!.scroll, `${where}: main scrolls sideways`).toBeLessThanOrEqual(o.main!.client);
  expect(o.scrollers, `${where}: an element inside main scrolls sideways`).toEqual([]);
}
