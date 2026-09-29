import { defineConfig, devices } from "@playwright/test";
import { SHOTS_NOW } from "./screenshots/clock.ts";

// The README screenshots (docs/images), taken from sample data only: the production
// build (dashboard/dist) under `vite preview` with the dev mock answering the API, as
// the browser tests run (playwright.config.ts). Build first: `npm run build`, then
// `npm run shots`. scripts/shots-privacy.mjs runs first and stops the run if the
// fixtures hold anything that looks real.
//
// WF_MOCK_NOW pins the mock's clock to the fixture's own "now" (screenshots/clock.ts),
// and the shots pin the browser's clock to the same time, so every relative and
// absolute time in the pictures is the same on every run.

// Its own port, so a shots run and an e2e run do not meet.
const PORT = 4175;

export default defineConfig({
  testDir: "screenshots",
  testMatch: "**/*.shots.ts",
  globalSetup: "./scripts/shots-privacy.mjs",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}/portal/`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/portal/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { WF_MOCK_NOW: SHOTS_NOW },
  },
});
