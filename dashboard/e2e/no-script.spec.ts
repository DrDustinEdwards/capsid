import { expect, test } from "@playwright/test";

// PLANT: the Portal once shipped browser-only and all 17 demo charts were empty with scripts off; this keeps server rendering fixed.
test.use({ javaScriptEnabled: false });

for (const [path, charts] of [
  ["demos/agents?tab=activity", 3],
  ["demos/sites?tab=deploys", 1],
  ["demos/sites/sample", 2],
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
