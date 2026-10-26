# The Capsid explorer

capsid.dustinedwards.info: the family of systems Dustin Edwards runs, how they connect, what Capsid is made of, and Capsid's daily numbers. Ruling: capsid/rulings/system-explorer-2026-10-10.md. Design: capsid/research/design-system-explorer.md, section 4.

Every page is prerendered from Capsid's two public documents (docs/public-data.md) by a daily build, so no reader's browser ever calls Capsid (answer 4). It is served by an assets-only Worker of its own, `capsid-explorer`, deployed from this folder (answer 8). The map is Capsomer's `system-map`; the charts are Enarratio's.

## Pages

- `/`: what Capsid is, performed: the core drawn playing a job's life, every tool it serves chosen from a list, how a claim becomes done beside a sample job, the jobs of the last eight weeks as bars, what it is made of, the family as a ledger, and the flows as tabs. Every figure is the day's public numbers.
- `/systems/`: the family as a capsid, and every system in a table filtered by ring and sorted by any column.
- `/tools/`: every tool Capsid serves over MCP, read at build from the Worker's own registrations (`src/surface.mjs`), filtered by what each may do. `/tools/{tool}/`: its description, the MCP hints it carries, its actions and every argument.
- `/numbers/`: the daily numbers as sentences, charts with their weekly trends where the document carries them, and one table.
- `/code/`: every public repo's size and health, the 25 riskiest functions and the weakest-tested modules.
- `/flows/`: every flow, each as its steps.
- `/search/`: every system, part, flow step, tool, action, module and function, from `assets/search.json`; `/` on any page goes there.
- `/s/{system}/`: one system: its facts, its parts, its connections grouped and drawn with its neighbors, the flows over it, its riskiest functions, the family map zoomed into its circle, and a link to the same system on dustinedwards.info/systems.
- `/s/{system}/containers/`: inside a public system with parts: a table and the lines between them, with the family map zoomed into its circle.
- The family map is Capsomer's system map with circles, the same code and drawing as dustinedwards.info/systems: one tap on any system zooms into its circle (its parts inside, what it works with outside, the systems it connects to on the rim), a system on the rim zooms there, and Back to all systems or Escape returns. The build searches every circle (`circleLayers`) and writes them to `assets/circles.json`, which the map fetches once the page has loaded; a page zoomed into a system carries its own circle in the HTML.
- `/flows/{flow}/`: a flow from the public model, what it is and every step. `/flows/{flow}/{step}/`, counted from 1 (`/flows/job-life/4/`): one step, its sentence, the parts it touches with links to them, Back and Next, every step, and the core drawn with the step's line on and its parts lit. With the script, Back, Next, the step list, number keys and the map's own controls step in place, the address following, and a token travels the line; under reduced motion it jumps. A step on a line the model lacks, or touching a private system, stops the build. The core's page and its parts page link each flow over its parts.
- `/s/{system}/code/`: a public system's code, from its repos' code maps (docs/public-data.md, "The code maps"): each module by folder with its riskiest function by CRAP and its mutation score, each a Capsomer status (shape, word and number, or "No data" with its reason), and its import cycles as text. Above each folder's table its modules are drawn as a graph, wires from importer to imported, each box edged in its worst status's color and a module in a cycle ringed; with several folders, the folders are drawn first. dagre lays the drawing out at build, so no layout code ships, and the drawing is hidden from assistive technology since the table holds the same modules. `/s/{system}/code/{path}/`: one module's functions, linked to their lines in its numbered source at the commit the map measured, and its imports both ways. A code map for a system that is not public stops the build before any source is read.
- A private system (one whose repo GitHub says is private) is drawn in full, its parts, lines and flows included, with no link to its repo and no code pages.

## Commands

From this folder, after `npm ci` at the repo root and here:

- `npm run check`: the build, the page renderers and the tests, type-checked.
- `npm test`: builds from `fixtures/` (invented systems on example.com) and checks the pages, the links, the headers and the script budget.
- `npm run e2e`: the browser spec. Builds the fixtures into `.e2e-dist`, serves them with `wrangler dev` using the deploy's config and `_headers`, and runs axe in both themes, the policy, and the map's keyboard, on desktop and phone. `e2e/award.spec.mjs` is the design's section 6 checklist in Chromium: every system reached by the arrow keys, the list against the model, no layout shift while entering or stepping a flow, the INP proxy under 4x CPU throttling, and frame gaps (warn only). `e2e/lighthouse.spec.mjs` runs Lighthouse, mobile, median of three, on four pages: CLS 0.05, TBT 150 ms and 3 MB fail; LCP fails over 2.5 s and warns over the design's 1.5 s. A real phone's frame rate and a screen reader are checked by hand at release.
- `npm run build`: builds from the live documents into `dist/`. `npm run build -- --model <file> --stats <file> --out <dir>` builds from files; add `--code <file>` for code pages.

## Deploy

`.github/workflows/explorer.yml`. A pull request that touches this folder, or a Capsid module the build loads (the test holds that list to the import graph), runs the checks above. On a push to master that changes this folder, once a day and by hand, it builds from the live documents and deploys only when `build.json`'s content hash differs from the one capsid.dustinedwards.info serves, then waits until the domain serves the new hash. Each new day's numbers change the hash, so a normal day deploys once; a day the public build did not run deploys nothing. A change to the schemas alone reaches the explorer at the next daily run, once the public build has written documents in the new shape.

The deploy job runs only when the repository variable `EXPLORER_DEPLOY` is `on`. It needs the `EXPLORER_CLOUDFLARE_API_TOKEN` secret (Cloudflare's "Edit Cloudflare Workers" token template, limited to this account and the dustinedwards.info zone, which the custom domain needs) beside the existing `CLOUDFLARE_ACCOUNT_ID`. Once the variable is on, a missing token fails the job instead of skipping it.

`wrangler-config.mjs` prints the Worker's config, which is generated, not committed.
