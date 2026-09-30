// The design tokens, generated from one seed colour. `node scripts/palette.mjs` writes
// src/tokens.css; `node scripts/palette.mjs --check` regenerates it in memory, refuses any
// difference from the committed file, and checks every text and control pair against
// WCAG 2.2 (4.5:1 for text, 3:1 for a control's boundary), in both themes. `npm run check`
// runs the check, so CI refuses a hand-edited hex and a pair that fell below the bar.
//
// Method (capsid/research/design-portal-linear.md, "Palette"): a 12-step scale in OKLCH,
// with the step roles the Radix Colors convention uses (1 and 2 the surface and ground,
// 3 raised, 4 sunken, 6 to 8 lines, 9 the accent, 11 and 12 text). Neutrals carry a small
// chroma at the seed's hue, so surfaces and text lean toward it. The accent in light is the
// seed itself; in dark it lightens until it meets the bar on its own tint. Status hues are
// fixed, never derived from the seed, and each is tuned by bisection against the hardest
// surface it sits on. The OKLab conversion follows Bjorn Ottosson's reference (2020).
//
// The file it writes is plain CSS custom properties and nothing else, so it can move
// unchanged into the shared design package (capsid/decisions.md 2026-09-30).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SEED = "#4F2D7F";
const OUT = fileURLToPath(new URL("../src/tokens.css", import.meta.url));

// ---- colour math ---------------------------------------------------------------------

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]) {
  r = toLinear(r);
  g = toLinear(g);
  b = toLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
}

const inGamut = (rgb) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

// A hex colour for oklch(L C H); the chroma is pulled in until the colour fits sRGB.
export function oklch(L, C, H) {
  for (let c = C; c >= 0; c -= 0.002) {
    const rgb = oklabToRgb([L, c * Math.cos((H * Math.PI) / 180), c * Math.sin((H * Math.PI) / 180)]);
    if (inGamut(rgb)) return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
  }
  throw new Error(`no sRGB colour for oklch(${L} ${C} ${H})`);
}

const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// WCAG 2.x contrast ratio between two hex colours.
export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The lightness closest to `from` at which oklch(L C H) reaches `target` against `bg`.
// `to` is the high-contrast end; the search keeps a lightness that meets the target.
function tune(C, H, bg, target, from, to) {
  let lo = from;
  let hi = to;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(oklch(mid, C, H), bg) >= target) hi = mid;
    else lo = mid;
  }
  return oklch(hi, C, H);
}

// ---- the scales ----------------------------------------------------------------------

const [seedL, seedA, seedB] = rgbToOklab(hexToRgb(SEED));
const HUE = ((Math.atan2(seedB, seedA) * 180) / Math.PI + 360) % 360;
const SEED_CHROMA = Math.hypot(seedA, seedB);
const NEUTRAL_CHROMA = 0.012;
// Status hues are kept; only lightness is tuned. info also colours a running job.
const STATUS = { ok: 150, warn: 78, crit: 26, info: 255 };
const TEXT = 4.6; // a little above 4.5, so rounding to hex cannot fall under it
const CONTROL = 3.0;

function light() {
  const t = {};
  t.ground = oklch(0.965, NEUTRAL_CHROMA, HUE);
  t.surface = oklch(0.995, 0.003, HUE);
  t.raised = oklch(0.975, 0.008, HUE);
  t.sunken = oklch(0.93, NEUTRAL_CHROMA, HUE);
  t.line = oklch(0.9, NEUTRAL_CHROMA, HUE);
  // A control's border sits on the raised tone as well as the surface; raised is darker.
  t["line-strong"] = tune(NEUTRAL_CHROMA, HUE, t.raised, CONTROL, 0.9, 0.3);
  t.text = oklch(0.22, 0.03, HUE);
  t.muted = tune(0.02, HUE, t.ground, 5.5, 0.9, 0.2);
  // dim also sits on the sunken tone (a read-only field's placeholder), the darkest surface.
  t.dim = tune(0.02, HUE, t.sunken, TEXT, 0.9, 0.2);
  t.accent = SEED;
  t["accent-hover"] = oklch(seedL - 0.06, SEED_CHROMA, HUE);
  t["accent-soft"] = oklch(0.93, 0.045, HUE);
  t.sel = oklch(0.955, 0.03, HUE);
  // The selection's ring, at a control's bar against the selected row itself.
  t["accent-line"] = tune(0.1, HUE, t.sel, CONTROL, 0.9, 0.3);
  for (const [k, H] of Object.entries(STATUS)) {
    // A status word sits on the surface, the raised tone, the ground, its own tint, the
    // active menu item (a count on accent-soft) and a selected row; tuned against the
    // darkest of those, it passes on all of them.
    t[`${k}-soft`] = oklch(0.945, 0.05, H);
    t[k] = tune(0.14, H, darkest(t[`${k}-soft`], t["accent-soft"], t.sel), TEXT, 0.9, 0.2);
  }
  t.nodata = t.dim;
  t["nodata-soft"] = oklch(0.94, 0.006, HUE);
  return t;
}

const darkest = (...hexes) => hexes.reduce((a, b) => (luminance(b) < luminance(a) ? b : a));
const lightest = (...hexes) => hexes.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));

function dark() {
  const t = {};
  t.ground = oklch(0.16, NEUTRAL_CHROMA, HUE);
  t.surface = oklch(0.205, NEUTRAL_CHROMA, HUE);
  t.raised = oklch(0.245, NEUTRAL_CHROMA, HUE);
  t.sunken = oklch(0.135, NEUTRAL_CHROMA, HUE);
  t.line = oklch(0.32, NEUTRAL_CHROMA, HUE);
  t["line-strong"] = tune(NEUTRAL_CHROMA, HUE, t.raised, CONTROL, 0.2, 0.9);
  t.text = oklch(0.95, 0.008, HUE);
  t.muted = tune(0.015, HUE, t.surface, 6.0, 0.2, 0.95);
  t.dim = tune(0.015, HUE, t.raised, TEXT, 0.2, 0.95);
  t["accent-soft"] = oklch(0.3, 0.06, HUE);
  t.sel = oklch(0.27, 0.045, HUE);
  t["accent-line"] = tune(0.1, HUE, t.sel, CONTROL, 0.2, 0.9);
  t.accent = tune(0.12, HUE, t["accent-soft"], TEXT, 0.3, 0.95);
  t["accent-hover"] = oklch(0.8, 0.11, HUE);
  for (const [k, H] of Object.entries(STATUS)) {
    // In dark the lightest of the tint, the active menu item and a selected row is the hardest.
    t[`${k}-soft`] = oklch(0.28, 0.05, H);
    t[k] = tune(0.13, H, lightest(t[`${k}-soft`], t["accent-soft"], t.sel), TEXT, 0.3, 0.95);
  }
  t.nodata = t.dim;
  t["nodata-soft"] = oklch(0.27, 0.006, HUE);
  return t;
}

// ---- the pairs every theme must pass ---------------------------------------------------

export function failures(t) {
  const out = [];
  const need = (fg, bg, min, what) => {
    const r = contrast(t[fg], t[bg]);
    if (r < min) out.push(`${what}: --${fg} ${t[fg]} on --${bg} ${t[bg]} is ${r.toFixed(2)}:1, needs ${min}:1`);
  };
  for (const bg of ["surface", "ground", "raised"]) {
    for (const fg of ["text", "muted", "dim", "accent"]) need(fg, bg, 4.5, "text");
    for (const s of Object.keys(STATUS)) need(s, bg, 4.5, "status word");
  }
  need("text", "sel", 4.5, "selected row title");
  need("muted", "sel", 4.5, "selected row detail");
  need("text", "sunken", 4.5, "command block");
  need("dim", "sunken", 4.5, "command block note");
  for (const bg of ["surface", "raised"]) need("line-strong", bg, 3, "control border");
  need("accent-line", "sel", 3, "selection ring");
  need("accent", "surface", 3, "focus ring");
  for (const s of Object.keys(STATUS)) {
    need(s, `${s}-soft`, 4.5, "pill");
    need(s, "accent-soft", 4.5, "count on the active menu item");
    need(s, "sel", 4.5, "status word on a selected row");
  }
  need("accent", "accent-soft", 4.5, "active item");
  need("surface", "accent", 4.5, "primary button label");
  need("surface", "crit", 4.5, "badge label");
  return out;
}

// ---- the file --------------------------------------------------------------------------

const ORDER = ["ground", "surface", "raised", "sunken", "line", "line-strong", "text", "muted", "dim", "accent", "accent-hover", "accent-soft", "accent-line", "sel", "ok", "ok-soft", "warn", "warn-soft", "crit", "crit-soft", "info", "info-soft", "nodata", "nodata-soft"];

function block(t, indent, scheme) {
  const lines = ORDER.map((k) => `${indent}--${k}: ${t[k]};`);
  const shadowInk = scheme === "dark" ? "0, 0, 0" : hexToRgb(t.text).map((v) => Math.round(v * 255)).join(", ");
  lines.push(
    scheme === "dark"
      ? `${indent}--shadow: 0 1px 0 rgba(${shadowInk}, 0.3), 0 12px 32px -14px rgba(${shadowInk}, 0.7);`
      : `${indent}--shadow: 0 1px 0 rgba(${shadowInk}, 0.04), 0 10px 28px -12px rgba(${shadowInk}, 0.22);`,
  );
  lines.push(`${indent}--scrim: rgba(${shadowInk}, ${scheme === "dark" ? "0.55" : "0.28"});`);
  lines.push(`${indent}color-scheme: ${scheme};`);
  return lines.join("\n");
}

export function render() {
  const l = light();
  const d = dark();
  const hue = HUE.toFixed(1);
  return `/* Generated by scripts/palette.mjs from the seed ${SEED} (oklch hue ${hue}). Do not edit:
   run \`npm run tokens\` after changing the script. \`npm run check\` refuses a file that
   differs from what the script writes, and any pair below WCAG 2.2's bar.
   Design tokens only, no selectors beyond the theme roots, so this file can move unchanged
   into the shared design package (capsid/decisions.md 2026-09-30). */
:root {
${block(l, "  ", "light")}
  --ui: "Schibsted Grotesk", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --mono: "Martian Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${block(d, "    ", "dark")}
  }
}
:root[data-theme="dark"] {
${block(d, "  ", "dark")}
}
`;
}

export function check() {
  const problems = [];
  const l = light();
  const d = dark();
  problems.push(...failures(l).map((p) => `light: ${p}`));
  problems.push(...failures(d).map((p) => `dark: ${p}`));
  let committed = null;
  try {
    committed = readFileSync(OUT, "utf8");
  } catch (e) {
    problems.push(`src/tokens.css cannot be read (${e instanceof Error ? e.message : String(e)}); run npm run tokens`);
  }
  if (committed !== null && committed !== render()) {
    const a = committed.split("\n");
    const b = render().split("\n");
    const i = a.findIndex((line, n) => line !== b[n]);
    problems.push(`src/tokens.css differs from what the script writes at line ${i + 1}: "${a[i] ?? ""}" (committed) vs "${b[i] ?? ""}" (script); run npm run tokens`);
  }
  return problems;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, "/").replace(/^([a-z]):/i, (m) => m.toUpperCase());
if (invoked || (process.argv[1] && process.argv[1].endsWith("palette.mjs"))) {
  if (process.argv.includes("--check")) {
    const problems = check();
    if (problems.length) {
      console.error(`palette: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log("palette: src/tokens.css matches the script and every pair meets WCAG 2.2 in both themes");
  } else if (process.argv.includes("--table")) {
    for (const [name, t] of [["light", light()], ["dark", dark()]]) {
      console.log(`\n${name}`);
      for (const k of ORDER) console.log(`  --${k}: ${t[k]}`);
    }
  } else {
    writeFileSync(OUT, render());
    console.log(`palette: wrote src/tokens.css from ${SEED}`);
  }
}
