# Capsid Portal

The operations dashboard the capsid Worker serves at `/portal/`. A React app
built with Vite, reading one endpoint: `GET /portal/api/ops`, whose shape is
`OpsFeed` in [`../src/ops-types.ts`](../src/ops-types.ts). The app imports those
types with `import type` and never imports runtime code from the Worker.

## Run it locally

```sh
cd dashboard
npm ci
npm run dev
```

Open http://localhost:5173/portal/. The dev server answers
`/portal/api/ops` and `POST /portal/api/ops/refresh` from
[`dev/sample-feed.json`](dev/sample-feed.json), a fake feed (sites under
`example.com`, namespaces `sample*`), with every timestamp shifted so the feed
reads as current. A second refresh within 30 s answers 429, as the Worker does.

Other states, for looking at the empty and failure paths:

```sh
WF_MOCK=signed-out npm run dev   # 401: the "Signed out" state
WF_MOCK=no-snapshot npm run dev  # the watcher has not written its first pass
WF_MOCK=no-token npm run dev     # Cloudflare read not configured
WF_MOCK=no-sites npm run dev     # no site configured: no Sites view, no site items
```

## Check, build, budget

```sh
npm run check   # the fixture against OpsFeed, then tsc --noEmit
npm run build   # check, then vite build into dist/
npm run size    # the size budget; run after build
```

`npm run check` writes `dev/generated/sample-feed.check.ts` (gitignored), the
fixture as an `as const` literal that `satisfies` the contract, so a field the
contract lacks, a missing field or a value outside a union fails the typecheck.

`npm run size` reads `dist/.vite/manifest.json` and fails (non-zero exit) when:

| What | Budget (gzip) |
| --- | --- |
| Initial JS: the entry and its static imports | 100 KB |
| Each lazy chunk | 40 KB |
| All CSS | 12 KB |
| Fonts | reported, not budgeted |

A missing `dist/` or manifest is a failure, not a pass.

## Constraints the build keeps

- Served with `script-src 'self'; style-src 'self'; font-src 'self'`: no inline
  script or style in `index.html`, fonts self-hosted from `@fontsource`, and
  `assetsInlineLimit: 0` so nothing becomes a `data:` URL.
- Base path `/portal/`; hashed file names under `assets/`.
- Read only. A blocked job's drawer copies its command and the resume call; the
  dashboard never makes the call.
- A number the feed does not have is shown as "No data" with the reason, never as 0.

## Keyboard

`Ctrl K` or `/` opens the command menu. `g` then `o s i q d a b c n l e` goes to a view
(`s`, Sites, only while a site is configured; `e` is Settings),
`j` and `k` move through rows, `Enter` opens one, `Esc` closes, `r` refreshes,
`t` switches theme, `f` focuses the queue filter, `?` shows the sheet, where
single-key shortcuts can be turned off.
