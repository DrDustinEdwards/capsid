import { expect, type Page } from "@playwright/test";
import { MOVED, VIEWS, placePath, type MovedId, type ViewId } from "../src/app/ctx.ts";

// Every view the app registers, so a new view is covered without editing a test. The
// count is asserted where it is used: an empty list would otherwise pass vacuously.
export const ALL_VIEWS = VIEWS.map((v) => ({ id: v.id as ViewId, label: v.label as string }));
export const VIEW_COUNT = 9;

// A place: a view, or a retired view's id (MOVED in src/app/ctx.ts), which names the page,
// section or tab that holds its content now.
export type Place = ViewId | MovedId;

// Relative to the /portal/ base URL.
function urlOf(id: Place): string {
  return `.${placePath(id)}`;
}

// Opens a place and waits until its page's heading is up and nothing on it is still
// loading.
export async function visit(page: Page, id: Place): Promise<void> {
  const view = Object.hasOwn(MOVED, id) ? MOVED[id as MovedId].view : id;
  const label = ALL_VIEWS.find((v) => v.id === view)!.label;
  await page.goto(urlOf(id));
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await expect(page.locator("main .loading")).toHaveCount(0);
}

export interface Overflow {
  doc: { scroll: number; client: number };
  root: { scroll: number; client: number } | null;
  // Elements inside the root that scroll sideways: overflow-x auto or scroll, and wider
  // than their box. A scroll-x wrapper that actually scrolls counts.
  scrollers: string[];
}

// root: "main" for a view, the drawer's selector for a drawer.
export async function measure(page: Page, root = "main"): Promise<Overflow> {
  return page.evaluate((sel) => {
    const de = document.documentElement;
    const r = document.querySelector<HTMLElement>(sel);
    const scrollers: string[] = [];
    for (const el of r?.querySelectorAll<HTMLElement>("*") ?? []) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        scrollers.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, ".")} ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return {
      doc: { scroll: de.scrollWidth, client: de.clientWidth },
      root: r ? { scroll: r.scrollWidth, client: r.clientWidth } : null,
      scrollers,
    };
  }, root);
}

// Every way the page scrolls sideways, named; empty when it does not.
export function sideways(o: Overflow, where: string): string[] {
  const out: string[] = [];
  if (o.doc.scroll > o.doc.client) out.push(`${where}: the document is ${o.doc.scroll} px wide in ${o.doc.client}`);
  if (!o.root) out.push(`${where}: the element to measure is missing`);
  else if (o.root.scroll > o.root.client) out.push(`${where}: it is ${o.root.scroll} px wide in ${o.root.client}`);
  for (const s of o.scrollers) out.push(`${where}: ${s} scrolls sideways`);
  return out;
}

export function expectNoSideways(o: Overflow, where: string): void {
  expect(sideways(o, where)).toEqual([]);
}
