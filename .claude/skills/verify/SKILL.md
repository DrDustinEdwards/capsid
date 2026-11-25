---
name: verify
description: Use before committing or opening a pull request that changes what the Capsid Portal shows or does. Boots the Portal's production build the way the Worker renders it, drives the changed flow end to end in Chromium with Playwright, and reports the evidence. Not for Worker-only or MCP tool changes (those are proved in test-integration/).
---

# Verify a Portal change

Do it before every commit that touches `dashboard/`, `src/portal-*.ts` or
`src/dashboard-csp.ts`, and before the pull request.

## 1. Boot the build the browser tests use

From `dashboard/`, on the repo's Node (`.nvmrc`; the SessionStart hook puts it on
PATH in a cloud session):

```sh
npm ci
npm run build
node --import ../test/resolve-ts.mjs dev/serve.ts 4174   # run in the background
```

`dev/serve.ts` serves the Worker's build with its CSP and `dev/mock-api.ts` in
place of `/portal/api/*` (fake data). Wait until
`curl -s -o /dev/null -w '%{http_code}' http://localhost:4174/` prints 200.

For the empty and failure states, start it with `WF_MOCK=signed-out`,
`no-snapshot`, `no-token` or `no-sites` (dashboard/README.md). `npm run dev`
(Vite, port 5173) is for quick looks only: it does not send the Worker's CSP.

## 2. Drive the changed flow

Write a short script in the session's scratchpad, never in the repo. Name each
step the way a person would say it, act through roles and labels, and assert what
the person should see afterward. Collect console errors and page errors, and keep
a screenshot of the end state.

```js
// <scratchpad>/drive.mjs: REPO=<repo>/dashboard node drive.mjs http://localhost:4174/
import { createRequire } from "node:module";
const { chromium } = createRequire(`${process.env.REPO}/package.json`)("@playwright/test");
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const log = [];
async function step(name, fn) {
  try {
    await fn();
    log.push(`ok   ${name}`);
  } catch (e) {
    log.push(`FAIL ${name}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: "fail.png", fullPage: true });
    throw e;
  }
}
try {
  await step("open Needs you", async () => {
    const r = await page.goto(process.argv[2]);
    if (!r.ok()) throw new Error(`status ${r.status()}`);
    await page.locator("#waiting").waitFor();
  });
  // ...the changed flow: click, fill, confirm, then assert the visible result.
  await page.screenshot({ path: "after.png", fullPage: true });
} finally {
  console.log(log.join("\n"));
  console.log("console errors:", errors.length ? errors : "none");
  await browser.close();
}
```

Drive the whole flow (act, see the result, reload and see it hold); repeat the end
state at 390 px and dark when the change is responsive or themed.

In a cloud session the repo's Playwright build may not match the Chromium the
container ships, and launch fails with "Executable doesn't exist". Then set
`PW_CHROMIUM=/opt/pw-browsers/chromium`. Do not run `playwright install`.

## 3. Run the specs that cover the area

Run the existing spec for the view you changed (`dashboard/e2e/`), not the whole
suite; CI runs all of it. Stop the step 1 server first, because the config starts
its own. On a machine with Playwright's browsers installed, `npx playwright test
e2e/<name>.spec.ts`. In a cloud session, run it through a wrapper config in the
scratchpad that launches the container's Chromium:

```js
// <scratchpad>/cloud.config.mjs
const repo = process.env.REPO;
const { default: base } = await import(`${repo}/playwright.config.ts`);
const launchOptions = { executablePath: process.env.PW_CHROMIUM };
export default {
  ...base,
  testDir: `${repo}/${base.testDir}`,
  outputDir: `${process.env.OUT}/test-results`,
  use: { ...base.use, launchOptions },
  projects: base.projects.map((p) => ({ ...p, use: { ...p.use, launchOptions } })),
  webServer: { ...base.webServer, cwd: repo },
};
```

```sh
cd dashboard
REPO=$PWD OUT=<scratchpad> PW_CHROMIUM=/opt/pw-browsers/chromium \
  npx playwright test -c <scratchpad>/cloud.config.mjs <name>.spec.ts
```

## Rules

A failed step is a finding about the change: fix the code and rerun the same
script; no sleeps, no looser selectors. Stop the server by the process id you
started, never `pkill` by name.

## The report

Put this in the reply and the pull request body:

- First line: verified, partly verified (and what was not), or failed.
- Each step's ok or FAIL line, the console errors line, the end-state screenshot
  attached, and the spec run's summary line.
- Not verified: a live Cloudflare read, the Access sign-in, real GitHub data. The
  live check after the merge deploys is `.claude/rules/deploy.md`.
