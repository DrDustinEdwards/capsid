import { expect, test, type Page } from "@playwright/test";
import { visit } from "./views.ts";

// Contrast as the browser paints it, in both themes: the colour of real text against the
// background behind it, not the tokens on their own (Capsomer's palette check covers those).
// WCAG 2.2: 4.5:1 for text, 3:1 for a control's boundary and the selection ring.

interface Reading {
  fg: string;
  bg: string;
  ratio: number;
}

// The first painted background behind an element, compositing translucent layers.
function readPair(page: Page, selector: string, part: "color" | "border"): Promise<Reading | null> {
  return page.evaluate(
    ([sel, which]) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return null;
      const parse = (s: string): [number, number, number, number] => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        const inner = m?.[1];
        if (!inner) return [0, 0, 0, 0];
        const p = inner.split(/[\s,\/]+/).filter(Boolean).map(Number);
        return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p.length > 3 ? (p[3] ?? 1) : 1];
      };
      const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => {
        const a = top[3];
        return [Math.round(top[0] * a + under[0] * (1 - a)), Math.round(top[1] * a + under[1] * (1 - a)), Math.round(top[2] * a + under[2] * (1 - a))];
      };
      let bg: [number, number, number] = [255, 255, 255];
      const layers: [number, number, number, number][] = [];
      for (let n: HTMLElement | null = which === "color" ? el.parentElement : el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0) layers.unshift(c);
        if (c[3] >= 1) break;
      }
      for (const l of layers) bg = over(l, bg);
      const fgRaw = parse(which === "color" ? getComputedStyle(el).color : getComputedStyle(el).borderTopColor);
      const fg = over(fgRaw, bg);
      const lum = (c: [number, number, number]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const a = lum(fg);
      const b = lum(bg);
      const hex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
      return { fg: hex(fg), bg: hex(bg), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    },
    [selector, part] as const,
  );
}

// Text that the sample feed puts on the Overview, Sites and the Queue, in each tone the app
// uses, and one control border. Every selector must match, so a renamed class fails here
// rather than passing vacuously.
const TEXT: Array<{ view: "overview" | "sites" | "queue"; sel: string; what: string }> = [
  { view: "overview", sel: ".pagehead h1", what: "the heading" },
  { view: "overview", sel: ".tile .l", what: "muted text" },
  { view: "overview", sel: ".attention > header .src", what: "dim text" },
  { view: "overview", sel: ".att-row .st.crit", what: "a critical status word" },
  { view: "overview", sel: ".att-row .st.warn", what: "a warning status word" },
  { view: "overview", sel: ".att-row .st.nodata", what: "a no-data status word" },
  { view: "queue", sel: ".qrow .st.run", what: "a running status word" },
  { view: "overview", sel: ".cap-admin-menu a:not([aria-current])", what: "an inactive menu item" },
  { view: "overview", sel: ".cap-admin-menu a:not([aria-current]) .cap-admin-count[data-tone='crit']", what: "a critical menu count" },
  { view: "overview", sel: ".tile.crit .v", what: "a critical figure" },
  { view: "sites", sel: ".fleet .pill.ok", what: "an ok pill" },
  { view: "sites", sel: ".fleet .pill.warn", what: "a warning pill" },
  { view: "sites", sel: ".fleet .pill.crit", what: "a critical pill" },
  { view: "sites", sel: ".fleet .pill.nodata", what: "a no-data pill" },
  { view: "sites", sel: ".chip[aria-pressed='true']", what: "the pressed filter chip" },
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    for (const view of ["overview", "sites", "queue"] as const) {
      test(`${view}: every text tone reaches 4.5:1 against what is behind it`, async ({ page }) => {
        await visit(page, view);
        const wanted = TEXT.filter((t) => t.view === view);
        expect(wanted.length).toBeGreaterThan(0);
        const low: string[] = [];
        for (const t of wanted) {
          const r = await readPair(page, t.sel, "color");
          expect(r, `${t.what} (${t.sel}) is on the ${view} in ${scheme}`).not.toBeNull();
          if (r && r.ratio < 4.5) low.push(`${t.what}: ${r.fg} on ${r.bg} is ${r.ratio.toFixed(2)}:1`);
        }
        expect(low).toEqual([]);
      });
    }

    test("a button's border reaches 3:1 against its background", async ({ page }) => {
      await visit(page, "overview");
      const r = await readPair(page, ".cap-admin-bar .btn", "border");
      expect(r).not.toBeNull();
      expect(r!.ratio, `${r!.fg} on ${r!.bg}`).toBeGreaterThanOrEqual(3);
    });
  });
}
