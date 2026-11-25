import { expect, type Page } from "@playwright/test";
import { VIEWS, placePath, type ViewId } from "../src/app/ctx.ts";

// The count is asserted where used, since an empty list would pass vacuously.
export const ALL_VIEWS = VIEWS.map((v) => ({
  id: v.id as ViewId,
  label: v.label as string,
}));
export const VIEW_COUNT = 11;

export type Place = ViewId | `${ViewId}#${string}`;

function urlOf(id: Place): string {
  return `.${placePath(id)}`;
}

export async function visit(page: Page, id: Place): Promise<void> {
  const view = id.split("#")[0] as ViewId;
  const label = ALL_VIEWS.find((v) => v.id === view)!.label;
  await page.goto(urlOf(id));
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await expect(page.locator("main .cap-spinner[data-layout='page']")).toHaveCount(0);
}

export interface Overflow {
  doc: { scroll: number; client: number };
  root: { scroll: number; client: number } | null;
  scrollers: string[];
}

export async function measure(page: Page, root = "main"): Promise<Overflow> {
  // Measured open, as a visitor would see it.
  const opened = await page.evaluate((sel) => {
    const closed = [
      ...(document
        .querySelector(sel)
        ?.querySelectorAll<HTMLDetailsElement>("details:not([open])") ?? []),
    ];
    for (const d of closed) d.open = true;
    return closed.length;
  }, root);
  // A chart redraws after the fold opens (a resize observer, then a render), so the measure waits up to two seconds.
  if (opened) {
    await page
      .waitForFunction(
        (sel) =>
          [
            ...(document
              .querySelector(sel)
              ?.querySelectorAll<HTMLElement>("details[open] .enarratio-frame") ?? []),
          ].every((f) => f.scrollWidth <= f.clientWidth + 1),
        root,
        { timeout: 2000 },
      )
      .catch(() => {});
  }
  return page.evaluate((sel) => {
    const de = document.documentElement;
    const r = document.querySelector<HTMLElement>(sel);
    const scrollers: string[] = [];
    for (const el of r?.querySelectorAll<HTMLElement>("*") ?? []) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        scrollers.push(
          `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, ".")} ${el.scrollWidth} > ${el.clientWidth}`,
        );
      }
    }
    return {
      doc: { scroll: de.scrollWidth, client: de.clientWidth },
      root: r ? { scroll: r.scrollWidth, client: r.clientWidth } : null,
      scrollers,
    };
  }, root);
}

export function sideways(o: Overflow, where: string): string[] {
  const out: string[] = [];
  if (o.doc.scroll > o.doc.client)
    out.push(`${where}: the document is ${o.doc.scroll} px wide in ${o.doc.client}`);
  if (!o.root) out.push(`${where}: the element to measure is missing`);
  else if (o.root.scroll > o.root.client)
    out.push(`${where}: it is ${o.root.scroll} px wide in ${o.root.client}`);
  for (const s of o.scrollers) out.push(`${where}: ${s} scrolls sideways`);
  return out;
}

export function expectNoSideways(o: Overflow, where: string): void {
  expect(sideways(o, where)).toEqual([]);
}
