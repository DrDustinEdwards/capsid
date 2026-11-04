# Capsid Portal

The operations dashboard the capsid Worker serves at `/portal/` (and at the root of
portal.dustinedwards.info). A React Router 8.5.1 app in framework mode, like the
network's other sites: every page is rendered on the server, so its text, tables
and charts are in the HTML with scripts off, then hydrates and moves in the
browser. Its data is TanStack Query's, prefetched on the server per request and
read from `/portal/api/*` after; the feed's shape is `OpsFeed` in
[`../src/ops-types.ts`](../src/ops-types.ts), imported with `import type`.

- `src/root.tsx`, `src/routes.ts` and `src/routes/`: the document, the route tree
  (the Portal's, and the same views again under `/demos` with sample data) and one
  route module per view.
- `src/server/prefetch.ts`: what each route reads before it renders.
- `src/worker.ts`: the module the capsid Worker imports. `vite.worker.config.ts`
  bundles it and the server build into `build/worker/portal.js`.

## Run it locally

```sh
cd dashboard
npm ci
npm run dev
```

Open http://localhost:5173/. The dev server answers `/api/*` (as
`/portal/api/*`) from [`dev/sample-feed.json`](dev/sample-feed.json), a fake feed
(sites under `example.com`, namespaces `sample*`), with every timestamp shifted so
the feed reads as current. A second refresh within 30 s answers 429, as the Worker
does. `npm run build && npm run serve` renders the production build the way the
Worker does, with the Worker's CSP; the browser tests run against it.

Other states, for looking at the empty and failure paths:

```sh
WF_MOCK=signed-out npm run dev   # 401: the "Signed out" state
WF_MOCK=no-snapshot npm run dev  # the watcher has not written its first pass
WF_MOCK=no-token npm run dev     # Cloudflare read not configured
WF_MOCK=no-sites npm run dev     # no site configured: no Sites view, no site items
```

## Check, build, budget

```sh
npm run check   # the fixture against OpsFeed, route types, then tsc --noEmit
npm run build   # check, react-router build, the Worker's module, the demo's data
npm run size    # the size budget; run after build
npm run e2e     # the browser tests, against the build
```

`npm run check` writes `dev/generated/sample-feed.check.ts` (gitignored), the
fixture as an `as const` literal that `satisfies` the contract, so a field the
contract lacks, a missing field or a value outside a union fails the typecheck.

`npm run size` reads React Router's asset manifest and fails (non-zero exit) when
the heaviest page is over budget; its header lists the limits and each raise. A
missing build is a failure, not a pass.

## Constraints the build keeps

- Served with a per-page nonce in `script-src`, `style-src 'self'` and
  `font-src 'self'`: no inline style, fonts self-hosted from `@fontsource`, and
  `assetsInlineLimit: 0` so nothing becomes a `data:` URL.
- Hashed file names under `assets/`, with Subresource Integrity.
- Hydration-safe: what the first render reads (the clock, saved preferences, the
  address hash) matches the server's, and changes only after hydration.
- Read only. A blocked job's drawer copies its command and the resume call; the
  dashboard never makes the call.
- A number the feed does not have is shown as "No data" with the reason, never as 0.

## Keyboard

`Ctrl K` or `/` opens the command menu. `g` then `y h p q l a k b e` goes to a page
(Needs you, Health, Pull requests, Jobs, Activity, Agents, Packages, Library,
Settings),
`j` and `k` move through rows, `Enter` opens one, `Esc` closes, `r` refreshes,
`t` switches theme, `f` focuses the queue filter, `?` shows the sheet, where
single-key shortcuts can be turned off.
