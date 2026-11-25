import { defineConfig, devices } from "@playwright/test";
import { SHOTS_NOW } from "./screenshots/clock.ts";

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
    baseURL: `http://localhost:${PORT}/`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      },
    },
  ],
  webServer: {
    command: `node --import ../test/resolve-ts.mjs dev/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { WF_MOCK_NOW: SHOTS_NOW },
  },
});
