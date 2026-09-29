import { defineConfig, devices } from "@playwright/test";

// The app's browser tests: the production build (dashboard/dist) under `vite preview`,
// with the dev mock answering the API and the Worker's page CSP on every response
// (dev/mock-api.ts). Build first: `npm run build`, then `npm run e2e`. The Worker's own
// behaviour behind these routes is tested in workerd (test-integration/).
const PORT = 4174;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}/console/app/`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/console/app/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
