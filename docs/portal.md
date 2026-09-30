# Capsid Portal

Capsid Portal is the administrator's view of Capsid, one app at `/portal/`: every site, the job queue across every namespace, the watcher's findings, deploys, agents, namespaces, activity, claims, backups and CI. The designs and their rulings are in Capsid at `capsid/research/design-ops-console.md` and `capsid/research/design-portal-unify.md`.

**It moved from `/console` with no redirects.** Until the move, a server-rendered summary page answered at `/console` and this app at `/console/app/`. The move deleted that page, after every part of it had a replacement here (the design's section 5), and every `/console` address now answers the Worker's plain 404. A browser signed in at `/console` signs in once more at `/portal/`, because the old cookies were scoped to `Path=/console`.

**It carries twelve controls**, each on the row it changes:
- the job drawer: resume a blocked job, release a claimed one, mark a job failed;
- the agent drawer: revoke an agent;
- the Queue view: the seat-start switch;
- the Agents view: the improve mode;
- the Namespaces view: pause and unpause, and reset the queue's circuit breaker when it is open;
- the Settings view: add, edit and remove a site.

Every control opens a dialog that previews what will change and the audit rows it will write, and nothing happens until "Do it" (the routes are below). Refresh reads the feed again and runs one watcher pass on demand, at most once per two minutes. For a blocked job the drawer also shows the command and the resume call, with Copy buttons.

## Where each view gets its data

The app reads one endpoint, `GET /portal/api/ops`, whose shape is `OpsFeed` in `src/ops-types.ts`. The app and the Worker both typecheck against that file. The feed has two parts.

**The snapshot** is the watcher's last pass, one KV read of `ops:snapshot`. The watcher writes it every 30 minutes, or on Refresh (`src/ops-snapshot.ts`, [autonomy.md](autonomy.md)). It holds:
- each check's result: clear, finding, or could not run;
- Capsid's `/health`;
- the backup mirror;
- each roster repo's latest CI run;
- the site configuration compared with the registered namespaces;
- a probe of every configured site, with a 7-day uptime ring;
- Cloudflare's view of each site, from `src/ops-cloudflare.ts`.

**The live part** is read from D1 and KV on every request. It holds:
- every open job, and every job that ended in the last day;
- the agents and their records;
- pull requests from the last week;
- what auto-merge left for the seat;
- seat-started sessions with their GitHub run links;
- the improve loop's mode and budget;
- each roster namespace's pause reason.

Three views read more when they open, and not on every poll:
- **Namespaces** reads `GET /portal/api/namespaces`: each namespace as `improve_status` reports it.
- **Activity** reads `GET /portal/api/activity`: the last 50 audit rows, filtered by namespace and actor. A job transition writes two rows with one action, actor and path, one for the job and one for its mirror document, and the view labels them `(job)` and `(mirror document)`.
- **Claims** reads `GET /portal/api/claims`: what agents said beside what the Worker verified (below).

**Relative times** ("2m ago") are measured on the server's clock: the app takes the skew between its clock and the feed's `generated` time when each feed arrives, and never measures a row against a time earlier than the read that returned it. A timestamp with no zone is read as UTC, since every time the Worker writes is.

## Claims

The Claims view shows what each agent said about its work beside what the Worker checked, and every time a human touched a job. The data is the three append-only tables of `migrations/0023_job_claims.sql`, read through `src/job-claims-read.ts`, the same readers the admin-only `claims` tool uses, so the view and the tool agree.

- **By agent.** One row per agent and namespace: jobs and claims, each check's counts (agree, disagree, unclaimed, unchecked), the touches by kind and by who made them, and the median and total wait. A touch on a job no agent has claimed yet has its own row. Filter by namespace, agent, and a since and before date; the filters live in the address.
- **By check.** The same agreement counts summed over the rows above, one row per check (`pr_merged`, `prs_opened`, `commits`, `files_changed`, `ci_green`).
- **A job.** Open one by id (the list offers the feed's jobs). Each claim shows what the agent stated, the self-reported versions and the Worker's build, and under it each check with the claimed and verified values side by side. Then the touch log, oldest first, with each wait.
- **Nothing stated is not zero.** A field the agent did not state shows as "not stated", a value the Worker could not check as "not checked", and a group with no measured wait as "no wait".
- **Bounded.** Each read carries a limit and the view says which one it hit. The whole dataset is read through the `claims` tool's `export` action.

## Sites are configuration

Which sites the Portal watches is configuration each install edits, not code (ruled 2026-09-29: monitoring panels are optional and configured per install). The rows live in the D1 table `ops_sites` (`migrations/0022_ops_sites.sql`, `src/ops-sites.ts`) and are edited in the **Settings** view.

- **A row per namespace.** A row with an origin is a site: its name, its origin (`https://` and a hostname, nothing else), an optional health route, its platform (`cloudflare` or `vercel`), and optionally the Worker script that serves it. A row with no origin records that the namespace serves no site, so its absence from the probes is a decision.
- **Edits are controls.** Add, edit and remove go through the same preview and perform as every other control, as `site_add`, `site_edit` and `site_remove`. The preview names every field that changes. An edit or a removal carries the row's `revision` from the preview and is refused if the row changed since. Each writes `ops-site-added`, `ops-site-edited` or `ops-site-removed` (with the row before and after) and then the click row.
- **What is checked.** The origin must be `https://` and a lowercase public hostname: no user, port, path, query or fragment, no IP address, no single-label or local name. A health path starts with `/` and uses only letters, digits and `- . _ ~ /`, with no empty, `.` or `..` segment. A script is named only for a Cloudflare site. A new row's namespace must be registered. The table's own CHECK constraints hold the origin and platform to both or neither.
- **Nothing configured.** With no row that has an origin, the watcher probes nothing and reads nothing from Cloudflare, and the Portal hides the Sites view and every site item on the Overview. Settings stays, since that is where the first site is added.
- **Every pass reads it.** The watcher reads the table at the start of each pass. If the read fails, no site check runs that pass: nothing is probed on a guess and no open site finding is cleared.
- **The site map check** compares the rows with the registered namespaces both ways. A registered namespace with no row, or a row for a namespace that is not registered, is a watcher finding.
- **The seed** is the list the code held before the move, so nothing changed on the deploy that moved it. Capsid's own row is probed in-process rather than over HTTP; the Portal cannot set that, and an edit that changes Capsid's origin clears it.

## No data is a state, never a zero

A value the feed does not have is shown as **No data** with its reason. It is never a zero, a dash that reads as zero, or a green default.

- **Deploys and errors.** These come from Cloudflare and need `CF_OPS_TOKEN` (below). Until it is set, both columns say "Cloudflare read not configured".
  - A Vercel site says its platform is not Cloudflare.
  - A custom-domain site whose Worker the watcher cannot find says so. Script names are never guessed: a `*.workers.dev` host names its script, and any other host is resolved from the account's Workers custom domains.
  - If the analytics query fails, the error column shows the query's error text.
- **Uptime.** Each half-hour slot the watcher did not run is hatched, not counted as up.
- **Backups.** Capsid's backup age comes from its own `/health`. No other site reports a backup yet: that arrives with each site's `/health` contract, one PR in each site's repo. Until then the column says so.

## The Cloudflare token

`CF_OPS_TOKEN` is a Cloudflare API token that can only read. The watcher needs two permissions:
- **Account Analytics Read**, for requests and errors per Worker per hour;
- **Workers Scripts Read**, for deployments and the custom-domain list.

The admin-only `cloudflare_config` MCP tool (`src/tools/cloudflare.ts`, reading through `src/ops-cloudflare-config.ts`) needs four more:
- **Account / Access: Apps and Policies / Read**, for `access_apps` and `access_policies`;
- **Account / Email Routing Addresses / Read**, for `email_addresses`;
- **Zone / Zone / Read**, to list the zones `email_rules` reads;
- **Zone / Email Routing Rules / Read**, for `email_rules`.

A 403 from any of these names the permission that is missing. The tool copies named fields only, so an Access for SaaS client secret, a SCIM credential or an application's aud tag never reaches the caller. It runs once per tool call, never from a Portal page.

To add the four to the existing token:
1. Open dash.cloudflare.com/profile/api-tokens.
2. On the token **capsid-portal-read**, choose **Edit**.
3. Add **Account / Access: Apps and Policies / Read**, **Account / Email Routing Addresses / Read**, **Zone / Email Routing Rules / Read** and **Zone / Zone / Read**.
4. Under **Zone Resources**, choose **All zones from the account**.
5. Choose **Continue to summary**, then **Update token**.

The secret value does not change, so no Worker secret is updated.

The account id comes from `CF_ACCOUNT_ID`, or from `R2_ACCOUNT_ID` when that is unset (the same account). Both are Worker secrets, never in the repo, and the improve loop's attempt code cannot see the token (`AttemptEnv`). The watcher calls Cloudflare once per pass and never once per page load.

## Using it

- **Where:** https://capsid.dustin-edwards.workers.dev/portal/, signed in through Cloudflare Access as `ADMIN_EMAIL`. **Sign out**, in the top bar, ends the Portal session in this browser. It works at phone width, with a bottom tab bar.
- **Keyboard:**
  - `Ctrl K` or `/` opens the command menu. It jumps to any site, job, agent or view, and copies a blocked job's command.
  - `g` then a letter goes to a view: `o` overview, `s` sites, `i` incidents, `q` queue, `d` deploys, `a` agents, `n` namespaces, `l` activity, `v` claims, `b` backups, `c` CI, `e` settings. With no site configured, `s` does nothing.
  - `j` and `k` move through a list, Enter opens the row, and Esc closes.
  - `r` refreshes and `t` switches light and dark.
  - `[` collapses the side menu to its icons, or expands it (also the button at the foot of the menu). This browser remembers the choice (localStorage `wf-rail`). Collapsed, each icon names its view in a tooltip, and a count shows as a dot.
  - `?` lists the keys. The sheet can turn single-key shortcuts off.
- **Width:** no view scrolls sideways from 1024 px up. The wide tables (Namespaces, the fleet, Agents) turn each row into a card when their panel is too narrow for the columns.
- **Freshness:** the top bar shows when the live part was read and when the watcher's pass ran. The stamp turns to the warning colour when the pass is older than two cadences, which means the watcher has gone quiet. The app polls every 60 seconds while its tab is visible.

## Building and changing it

`dashboard/` is its own package (React 19, Vite, wouter), with its own lockfile and README.
- **Develop:** `npm --prefix dashboard run dev` serves it with fake sample data (`dashboard/dev/sample-feed.json`, checked against `OpsFeed`).
- **Design tokens:** every colour, font and shadow is a custom property in `dashboard/src/tokens.css`, which `dashboard/scripts/palette.mjs` generates from the seed `#4F2D7F` as a 12-step OKLCH scale (the method and the reasons are in Capsid, `capsid/research/design-portal-linear.md`, "Palette"). Change the script, then `npm --prefix dashboard run tokens`; never edit the file. `npm run check:dashboard` regenerates it and refuses a file that differs, and refuses any text or control pair below WCAG 2.2's bar (4.5:1 for text, 3:1 for a boundary) in either theme. The file holds tokens and nothing else, so it can move unchanged into the shared design package (capsid/decisions.md 2026-09-30).
- **Deploy:** `scripts/deploy.mjs` builds it into `dashboard/dist` before every deploy, and the Worker serves those files as its static assets. A failed build stops the deploy.
- **Browser tests:** `npm run test:browser`, after `npm run build:dashboard`, drives the built app in Chromium through Playwright (`dashboard/e2e`). It runs under `vite preview` with the dev mock and the Worker's own page CSP (`src/dashboard-csp.ts`). CI runs it after the build. What it covers:
  - the confirm dialog: every Preview ends in a preview, a refusal, a timeout or a stated reason;
  - no sideways scrolling at 1920, 1440, 1280 and 1024 px on every view;
  - the phone layout;
  - the collapsible sidebar;
  - the Claims view: the aggregate, its filter, and a job's claims beside their checks;
  - contrast as painted, in both themes: each text tone, the status words and pills, and a button's border, against what is behind them;
  - the keyboard: `j` and `k` move the selection, Enter opens the row and Esc closes it, and the selected row can be seen (a changed background and a ring at 3:1).
- **Size budget:** CI and every deploy run `dashboard/scripts/size-budget.mjs`, which fails closed. The initial JavaScript must be at most 100 KB gzip, each lazily loaded view at most 40 KB, and all CSS at most 12 KB.
- **Assets config:** the `assets` block in `wrangler.jsonc.example` must keep `run_worker_first: true` and `not_found_handling: "none"`, and `test/dry-run-config.test.ts` fails if either changes. Without them the platform could answer a browser's `/authorize` or `/portal/callback` with the app's `index.html`, or serve the app's files without the gate.

## Who gets in

The administrator's Access session, and nothing else (`src/portal-auth.ts`).

- **The sign-in.** The Portal signs in through the same Cloudflare Access for SaaS app and the same `ADMIN_EMAIL` check as the MCP flow ([auth.md](auth.md)), with its own callback at `/portal/callback`, and turns the verified email into a signed cookie, `capsid_portal`, that lasts twelve hours. The check runs again on every request.
- **Cookies.** `capsid_portal`, `capsid_portal_csrf` and the sign-in's `capsid_portal_state` are all `HttpOnly; Secure; SameSite=Lax; Path=/portal`, so `/mcp` and `/ops` never see them. The sign-in returns only to `/portal` or a path under `/portal/`; anything else stored as the return lands on `/portal/`.
- **Sign out** (`POST /portal/api/sign-out`, the button in the top bar) expires `capsid_portal` and `capsid_portal_csrf` in this browser. It passes the same checks as an action, so another site cannot sign the administrator out. It ends the Portal session only: the Access session at the team domain is Cloudflare's, so the next visit may sign in again without asking for the email. The cookie is a signed assertion, not a session record, so a copy taken from this browser stays valid until it expires.
- **Machines.** An operator key or an agent key gets a 403 that says so. Those authenticate to `/ops/mcp`, which serves the same state through `improve_status` and `jobs`. A login redirect would send a machine to the Access sign-in.
- **It never merges and it never mints.** Merging can start a CI deploy, so that stays with `manage_pr` behind a caller holding `can_merge`. Minting hands out a key, so that stays with the `agents` tool. Neither is in the Portal's action list, and a test asserts their absence.

## Routes

Every route but the callback answers to one gate, `portalGate`: the Access session and `ADMIN_EMAIL` on every request, a 403 for any `Authorization` header, and the sign-in for no session. The router matches the callback and every `/portal/api/` route before the app's catch-all.

- **`GET /portal/api/ops`** returns `OpsFeed` (`src/ops-types.ts`), uncached: the watcher's last pass from KV, plus open jobs and jobs that ended in the last day, the agents with their records, pull requests recorded in the last week, the awaiting-seat set, seat-started sessions from the last week with the run each became, and the loop's mode and budget. It also carries each roster namespace's pause reason and the `csrf` value the controls send back. One request costs 10 D1 statements (plus one per unclaimed seat start in the pending window) and 7 KV reads plus one per roster namespace, run concurrently. `src/ops-feed.ts` states them and an integration test counts them.
- **`POST /portal/api/ops/refresh`** runs one watcher pass now and returns the new feed. It needs the header `X-Capsid-Ops: refresh`, which a cross-site form cannot send, and it runs at most once per two minutes (KV `ops:refresh:last`; a 429 with `Retry-After` inside that window, and a 503 when the stamp cannot be read or written). The click is audited as `portal-ops-refresh` under `access:<email>`.
- **`POST /portal/api/actions/preview`** and **`POST /portal/api/actions/perform`** are the twelve controls (`src/portal-actions.ts`). The confirm is a second request, as ruled 2026-09-11:
  - The preview takes `{action, params}`, reads the current state, writes nothing, and returns what will change, the audit rows the perform will write, and a signed token. The token is good for five minutes and carries the action, its params and the admin's email.
  - The perform takes only `{token}`, so what runs is exactly what the dialog showed.
  - Both refuse a `Sec-Fetch-Site` that is present and not `same-origin`.
  - Both need the header `X-Capsid-CSRF` to equal the cookie `capsid_portal_csrf`. The feed body carries that value, and a cross-site page cannot read the feed.
  - Refusals: 400 refused, 403 CSRF or cross-site, 410 expired (preview again), 413 too large.
  - A perform writes the shared mutator's audit row, then `portal-<action>` under `access:<email>`. Rows from before the move say `console-<action>` ([schema.md](schema.md)).
- **`GET /portal/api/namespaces`** returns each roster namespace as `improve_status` reports it, from the same function. **`GET /portal/api/activity?namespace=&actor=`** returns the last 50 audit rows, filtered.
- **`GET /portal/api/claims`** (`src/portal-claims.ts`) returns the per-agent aggregate, filtered by `namespace`, `agent`, `since` and `until` (ISO times; anything else is a text 400), or with `?job=<id>` one job's claims, checks and touches, and a JSON 404 for a job that does not exist. It reads through the `claims` tool's readers and writes nothing.
- **`POST /portal/api/sign-out`**, above.
- **Any other `/portal/api/` path** is a JSON 404 behind the gate, never the app's page.
- **`/portal/`** and everything under it serves the built app from the `ASSETS` binding, only after the gate. The page gets `no-store` and its own CSP (scripts, styles and fetches from this origin only); hashed files under `/portal/assets/` are cached privately for a year. A browser loading an unknown path as a page gets the app's page, so the app's own routes load; a missing file stays a 404. With no `ASSETS` binding the admin gets a 503 saying the Portal is not deployed.
- **Deploy config.** The Worker's `assets` block must set `run_worker_first: true` and `not_found_handling: "none"`. Without `run_worker_first`, Cloudflare serves any request that matches a file in the assets directory (its `/index.html` and `/assets/*`, at the root of the origin) without running the Worker, so without the gate. The integration pool calls the Worker directly, not through the assets router, so no request-level test can see the setting; `test/dry-run-config.test.ts` fails instead if `wrangler.jsonc.example` loses either value.
- **Seat-start runs.** A `repository_dispatch` returns no run id, so the run is learned when the runner trades its OIDC token at `/ops/runner-key`: the `runner-key-minted` audit row records the token's `run_id` claim and the run's URL, and the feed joins it to the start.
- **The live check.** `scripts/verify-live.mjs` gate 6 asserts `/portal/` answers an anonymous caller with the sign-in (302), and that `/console`, `/console/app/` and `/console/callback` each answer 404.
