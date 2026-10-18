// Lighthouse's half of the award checklist (capsid/research/design-system-explorer.md, section 6):
// mobile profile, median of three, on the pages a reader lands on. CLS 0.05, TBT 150 ms (the lab
// proxy for INP 100 ms) and 3 MB in total are the design's. LCP fails over 2.5 s and warns over the
// design's 1.5 s, the line Dustin accepted for dustinedwards.info's /systems on 2026-10-11. An
// unmeasured audit is a failure, never a pass. Once, on the desktop project: Lighthouse sets its
// own phone and network, so the project's device adds nothing.
import { expect, test } from "@playwright/test";
import lighthouse from "lighthouse";

const PAGES = ["/", "/s/hub/containers/", "/flows/sample-round/1/", "/s/theme/code/"];
const RUNS = 3;
const LCP_DESIGN_MS = 1500;
const BUDGETS = [
  { audit: "largest-contentful-paint", label: "LCP", max: 2500 },
  { audit: "cumulative-layout-shift", label: "CLS", max: 0.05 },
  { audit: "total-blocking-time", label: "TBT", max: 150 },
  { audit: "total-byte-weight", label: "weight", max: 3_000_000 },
];

const median = (/** @type {number[]} */ xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? (s[(s.length - 1) / 2] ?? NaN) : ((s[s.length / 2 - 1] ?? NaN) + (s[s.length / 2] ?? NaN)) / 2;
};

// One page at a time: Lighthouse's timings are worth nothing with another run sharing the machine.
test.describe.configure({ mode: "serial" });

for (const path of PAGES) {
  const port = 9333;
  test(`lighthouse: ${path} meets the design's budgets on a phone, median of ${RUNS}`, async ({ playwright, baseURL }, info) => {
    test.skip(info.project.name !== "desktop", "Lighthouse emulates its own phone; once is enough");
    test.setTimeout(180_000);
    // A browser of its own with the DevTools port open, as Lighthouse drives it.
    const browser = await playwright.chromium.launch({ ...info.project.use.launchOptions, args: [`--remote-debugging-port=${port}`] });
    try {
      /** @type {Record<string, number[]>} */
      const values = Object.fromEntries(BUDGETS.map((b) => [b.audit, []]));
      for (let run = 0; run < RUNS; run++) {
        const lhr = (await lighthouse(`${baseURL}${path}`, { port, logLevel: "error", output: "json", onlyCategories: ["performance"] }))?.lhr;
        expect(lhr?.runtimeError, `Lighthouse did not measure ${path}`).toBeUndefined();
        expect(lhr?.configSettings.formFactor).toBe("mobile");
        for (const b of BUDGETS) {
          const v = lhr?.audits[b.audit]?.numericValue;
          expect(typeof v === "number" && Number.isFinite(v), `${b.audit} did not measure on ${path}`).toBe(true);
          values[b.audit]?.push(/** @type {number} */ (v));
        }
      }
      for (const b of BUDGETS) {
        const v = median(values[b.audit] ?? []);
        console.log(`${path} ${b.label} median ${b.audit === "cumulative-layout-shift" ? v.toFixed(3) : Math.round(v)}`);
        if (b.audit === "largest-contentful-paint" && v > LCP_DESIGN_MS) {
          const text = `${path} LCP median ${Math.round(v)} ms, over the design's ${LCP_DESIGN_MS} ms`;
          console.log(`WARN ${text}`);
          info.annotations.push({ type: "warning", description: text });
        }
        expect(v, `${path} ${b.label} median`).toBeLessThan(b.max);
      }
    } finally {
      await browser.close();
    }
  });
}
