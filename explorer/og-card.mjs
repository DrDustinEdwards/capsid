// Draws src/og-card.png, the card every page shares: a travel poster in the manner of JPL's
// Visions of the Future (2016), after the 1930s national-park posters. Flat layered shapes in the
// teal family under Capsomer's amber sun, the site's own face for the words.
//
//   node og-card.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { chromium } from "@playwright/test";

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
// The family's faces (capsomer/fonts.css), each file inlined, as the page is set from a string.
const fonts = join(dirname(require.resolve("capsomer/package.json")), "fonts");
const faces = readFileSync(require.resolve("capsomer/fonts.css"), "utf8").replace(/url\("\.\.\/fonts\/([^"]+)"\)/g, (_m, /** @type {string} */ file) => `url(data:font/woff2;base64,${readFileSync(join(fonts, file)).toString("base64")})`);

// Capsomer's teal ramp (light 2, 8, 9 and the ink) and its amber (dark 9).
const sky = "#e6f2f2";
const hill = "#7db5b7";
const sea = "#008489";
const ink = "#0c1e1f";
const sun = "#f0b429";

/** A hexagon of Capsid's cells, pointed top and bottom. @param {number} x @param {number} y @param {number} r */
const cell = (x, y, r) => {
  const p = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
  });
  return `<polygon points="${p.join(" ")}" fill="${ink}" stroke="${sky}" stroke-width="4"/>`;
};

const html = `<!doctype html><meta charset="utf-8"><style>
${faces}
html, body { margin: 0; }
.card { position: relative; width: 1200px; height: 630px; overflow: hidden; font-family: "Schibsted Grotesk", sans-serif; color: ${ink}; }
svg { position: absolute; inset: 0; }
.words { position: absolute; left: 64px; top: 58px; }
.visit { font-size: 24px; font-weight: 700; letter-spacing: 0.32em; }
.name { font-size: 132px; font-weight: 800; line-height: 0.9; letter-spacing: -0.02em; }
.line { margin-top: 18px; font-size: 30px; font-weight: 600; line-height: 1.25; }
.site { position: absolute; left: 64px; bottom: 24px; color: ${sky}; font-size: 17px; font-weight: 700; letter-spacing: 0.22em; }
</style>
<div class="card">
<svg width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${sky}"/>
<circle cx="930" cy="240" r="150" fill="${sun}"/>
<path d="M0 360 L180 300 L360 340 L560 270 L760 330 L960 280 L1200 330 L1200 630 L0 630Z" fill="${hill}"/>
<path d="M0 430 L240 380 L470 420 L700 370 L940 410 L1200 380 L1200 630 L0 630Z" fill="${sea}"/>
${[0, 1, 2, 3, 4, 5, 6].map((i) => cell(120 + i * 160, 478 + (i % 2) * 36, 46)).join("")}
<path d="M0 568 L1200 548 L1200 630 L0 630Z" fill="${ink}"/>
</svg>
<div class="words"><div class="visit">VISIT</div><div class="name">CAPSID</div><div class="line">AI agents say it's done.<br>Capsid checks.</div></div>
<div class="site">CAPSID.DUSTINEDWARDS.INFO</div>
</div>`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(here, "src", "og-card.png") });
await browser.close();
console.log("og-card: wrote src/og-card.png");
