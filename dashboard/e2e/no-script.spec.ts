import { expect, test } from "@playwright/test";

// PLANT: the Portal's pages are rendered on the server (src/entry.server.tsx), so a reader with
// scripts off gets every chart, its words and its table. The Portal shipped as a browser-only app
// once, and the chart check (prelum-chart-audit, B2) found all 17 demo charts empty with scripts
// off; this is the check that it stays fixed. The demo pages are the ones a visitor and the live
// check open.
test.use({ javaScriptEnabled: false });

for (const [path, charts] of [
  ["demos/", 2],
  ["demos/sites?tab=deploys", 1],
  ["demos/sites/sample", 2],
  ["demos/queue", 3],
  ["demos/agents", 1],
  ["demos/packages", 1],
] as const) {
  test(`PLANT: with scripts off, ${path} has its ${charts} charts, each drawn with its table`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const frames = page.locator(".cap-chart");
    await expect(frames).toHaveCount(charts);
    for (const frame of await frames.all()) {
      await expect(frame.locator("svg[role='img']")).toHaveCount(1);
      await expect(frame.locator("table")).toHaveCount(1);
    }
  });
}
