import { defineConfig, devices } from "@playwright/test";

// The app's browser tests: the production build, rendered as the Worker renders it, with the
// dev mock answering the API and the Worker's page CSP on every response (dev/serve.ts). Build
// first: `npm run build`, then `npm run e2e`. The Worker's own behavior behind these routes is
// tested in workerd (test-integration/).
const PORT = 4174;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node --import ../test/resolve-ts.mjs dev/serve.ts ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
