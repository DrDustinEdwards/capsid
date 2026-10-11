// The explorer as a reader gets it: built from the fixtures, served by `wrangler dev` with the
// config that deploys (less the custom domain) and the _headers it writes, so the policy the
// browser enforces here is the one production sends.
import { defineConfig, devices } from "@playwright/test";

const PORT = 8790;
const OUT = ".e2e-dist";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: [
      `npm run build -- --model fixtures/model.json --stats fixtures/stats.json --out ${OUT}`,
      `node wrangler-config.mjs ${OUT} --local > ${OUT}.wrangler.json`,
      `npx --prefix .. wrangler dev --config ${OUT}.wrangler.json --port ${PORT} --ip 127.0.0.1`,
    ].join(" && "),
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
