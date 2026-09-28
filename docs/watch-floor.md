# Watch Floor

The operations dashboard: every site, the job queue across every namespace, the watcher's findings, deploys, agents, backups and CI in one app at `/console/app/`. The design and its rulings are in Capsid at `capsid/research/design-ops-console.md`. The routes and their gate are in [console.md](console.md).

**It is read only.** It can refresh and it links out, and nothing else. It shows the resume call for a blocked job with a Copy button; the seat or the console makes the call. The one action is Refresh, which reads the feed again and runs one watcher pass on demand, at most once per two minutes.

## Where each view gets its data

The app reads one endpoint, `GET /console/api/ops`, whose shape is `OpsFeed` in `src/ops-types.ts`. The app and the Worker both typecheck against that file. The feed has two parts.

**The snapshot** is the watcher's last pass, one KV read of `ops:snapshot`. The watcher writes it every 30 minutes, or on Refresh (`src/ops-snapshot.ts`, [autonomy.md](autonomy.md)). It holds:
- each check's result: clear, finding, or could not run;
- Capsid's `/health`;
- the backup mirror;
- each roster repo's latest CI run;
- the site map compared with the registered namespaces;
- a probe of every site in `src/ops-sites.ts`, with a 7-day uptime ring;
- Cloudflare's view of each site, from `src/ops-cloudflare.ts`.

**The live part** is read from D1 and KV on every request. It holds:
- every open job, and every job that ended in the last day;
- the agents and their records;
- pull requests from the last week;
- what auto-merge left for the seat;
- seat-started sessions with their GitHub run links;
- the improve loop's mode and budget.

## No data is a state, never a zero

A value the feed does not have is shown as **No data** with its reason. It is never a zero, a dash that reads as zero, or a green default.

- **Deploys and errors.** These come from Cloudflare and need `CF_OPS_TOKEN` (below). Until it is set, both columns say "Cloudflare read not configured".
  - A Vercel site says its platform is not Cloudflare.
  - A custom-domain site whose Worker the watcher cannot find says so. Script names are never guessed: a `*.workers.dev` host names its script, and any other host is resolved from the account's Workers custom domains.
  - If the analytics query fails, the error column shows the query's error text.
- **Uptime.** Each half-hour slot the watcher did not run is hatched, not counted as up.
- **Backups.** Capsid's backup age comes from its own `/health`. No other site reports a backup yet: that arrives with each site's `/health` contract, one PR in each site's repo. Until then the column says so.

## The Cloudflare token

`CF_OPS_TOKEN` is a Cloudflare API token that can only read. It has exactly two permissions:
- **Account Analytics Read**, for requests and errors per Worker per hour;
- **Workers Scripts Read**, for deployments and the custom-domain list.

The account id comes from `CF_ACCOUNT_ID`, or from `R2_ACCOUNT_ID` when that is unset (the same account). Both are Worker secrets, never in the repo, and the improve loop's attempt code cannot see the token (`AttemptEnv`). The watcher calls Cloudflare once per pass and never once per page load.

## Using it

- **Where:** https://capsid.dustin-edwards.workers.dev/console/app/, signed in through Cloudflare Access as `ADMIN_EMAIL`. It works at phone width, with a bottom tab bar.
- **Keyboard:**
  - `Ctrl K` or `/` opens the command menu. It jumps to any site, job, agent or view, and copies a blocked job's command.
  - `g` then a letter goes to a view: `o` overview, `s` sites, `i` incidents, `q` queue, `d` deploys, `a` agents, `b` backups, `c` CI.
  - `j` and `k` move through a list, Enter opens the row, and Esc closes.
  - `r` refreshes and `t` switches light and dark.
  - `?` lists the keys. The sheet can turn single-key shortcuts off.
- **Freshness:** the top bar shows when the live part was read and when the watcher's pass ran. The stamp turns to the warning colour when the pass is older than two cadences, which means the watcher has gone quiet. The app polls every 60 seconds while its tab is visible.

## Building and changing it

`dashboard/` is its own package (React 19, Vite, wouter), with its own lockfile and README.
- **Develop:** `npm --prefix dashboard run dev` serves it with fake sample data (`dashboard/dev/sample-feed.json`, checked against `OpsFeed`).
- **Deploy:** `scripts/deploy.mjs` builds it into `dashboard/dist` before every deploy, and the Worker serves those files as its static assets. A failed build stops the deploy.
- **Size budget:** CI and every deploy run `dashboard/scripts/size-budget.mjs`, which fails closed. The initial JavaScript must be at most 100 KB gzip, each lazily loaded view at most 40 KB, and all CSS at most 12 KB.
- **Assets config:** the `assets` block in `wrangler.jsonc.example` must keep `run_worker_first: true` and `not_found_handling: "none"`, and `test/dry-run-config.test.ts` fails if either changes. Without them the platform could answer a browser's `/authorize` or `/console/callback` with the app's `index.html`, or serve the app's files without the gate.
