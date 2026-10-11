# The Capsid explorer

capsid.dustinedwards.info: the family of systems Dustin Edwards runs, how they connect, what Capsid is made of, and Capsid's daily numbers. Ruling: capsid/rulings/system-explorer-2026-10-10.md. Design: capsid/research/design-system-explorer.md, section 4.

Every page is prerendered from Capsid's two public documents (docs/public-data.md) by a daily build, so no reader's browser ever calls Capsid (answer 4). It is served by an assets-only Worker of its own, `capsid-explorer`, deployed from this folder (answer 8). The map is Capsomer's `system-map`; the charts are Enarratio's.

## Pages

- `/`: the family as a capsid, with the daily numbers as charts and a table.
- `/s/{system}/`: one system chosen on the map, its facts, its connections, and a link to the same system on dustinedwards.info/systems.
- `/s/{system}/containers/`: inside a public system with parts: a table and the lines between them, with the map's drawing for Capsid, the one system the map draws inside.
- A private system's page says it is private and shows its name, and its address if it has one. It has no parts page.

## Commands

From this folder, after `npm ci` at the repo root and here:

- `npm run check`: the build, the page renderers and the tests, type-checked.
- `npm test`: builds from `fixtures/` (invented systems on example.com) and checks the pages, the links, the headers and the script budget.
- `npm run e2e`: the browser spec. Builds the fixtures into `.e2e-dist`, serves them with `wrangler dev` using the deploy's config and `_headers`, and runs axe in both themes, the policy, and the map's keyboard, on desktop and phone.
- `npm run build`: builds from the live documents into `dist/`. `npm run build -- --model <file> --stats <file> --out <dir>` builds from files.

## Deploy

`.github/workflows/explorer.yml`. A pull request that touches this folder, or a Capsid module the build loads (the test holds that list to the import graph), runs the checks above. On a push to master that changes this folder, once a day and by hand, it builds from the live documents and deploys only when `build.json`'s content hash differs from the one capsid.dustinedwards.info serves, then waits until the domain serves the new hash. Each new day's numbers change the hash, so a normal day deploys once; a day the public build did not run deploys nothing. A change to the schemas alone reaches the explorer at the next daily run, once the public build has written documents in the new shape.

The deploy job runs only when the repository variable `EXPLORER_DEPLOY` is `on`. It needs the `EXPLORER_CLOUDFLARE_API_TOKEN` secret (Cloudflare's "Edit Cloudflare Workers" token template, limited to this account and the dustinedwards.info zone, which the custom domain needs) beside the existing `CLOUDFLARE_ACCOUNT_ID`. Once the variable is on, a missing token fails the job instead of skipping it.

`wrangler-config.mjs` prints the Worker's config, which is generated, not committed.
