# Capsid Portal screenshots

The PNGs in this folder are pictures of the Capsid Portal drawn from sample data only:
the fake feed in `dashboard/dev/sample-feed.json` and the responses the dev mock
(`dashboard/dev/mock-api.ts`) seeds. None of them comes from the live Worker, and none
may. Hosts are `*.example.com`, people are `@example.com`, namespaces are `sample-*`.

## Regenerate

From the repo root:

```sh
npm ci --prefix dashboard
npm --prefix dashboard run build
npm --prefix dashboard run shots
```

`shots` runs `dashboard/playwright.shots.config.ts`: the production build under
`vite preview` with the mock answering the API, as the browser tests run. Before any
shot it runs `dashboard/scripts/shots-privacy.mjs`, which fails and names the value if
the fixtures hold an email outside example.com or example.org, a hostname that is not a
sample host, a real portfolio name, a job id outside the sample shape, or a
token-shaped string. Run it alone with `node dashboard/scripts/shots-privacy.mjs`.

The mock's clock and the browser's are both pinned to the fixture's own time
(`dashboard/screenshots/clock.ts`), so the same build gives the same pictures.

| File | What it shows |
| --- | --- |
| `health-light.png` | Health, light theme, 1440 x 900 |
| `health-dark.png` | Health, dark theme |
| `health-sites-light.png` | Health, opened at its Sites section |
| `queue-drawer-light.png` | Queue with a job's drawer open |
| `control-preview-light.png` | A job's Mark failed control with its preview open (never performed) |
| `activity-light.png` | Activity |
| `claims-light.png` | Agents, its Claims tab |
| `phone-health-light.png` | Health on a phone, 390 x 844 |
| `phone-health-dark.png` | Health on a phone, dark theme |
