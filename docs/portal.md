# Capsid Portal

Capsid Portal is the administrator's view of Capsid, one app at https://portal.dustinedwards.info (and at `/portal/` on the Worker's workers.dev address until the new one is verified live): every site, the job queue across every namespace, the watcher's findings, deploys, agents, namespaces, activity, claims, backups and CI. The designs and their rulings are in Capsid at `capsid/research/design-ops-console.md` and `capsid/research/design-portal-unify.md`.

**It moved from `/console` with no redirects.** Until the move, a server-rendered summary page answered at `/console` and this app at `/console/app/`. The move deleted that page, after every part of it had a replacement here (the design's section 5), and every `/console` address now answers the Worker's plain 404. A browser signed in at `/console` signs in once more at `/portal/`, because the old cookies were scoped to `Path=/console`.

**It carries fifteen controls**, each on the row it changes:
- the job drawer: resume a blocked job, release a claimed one, mark a job failed;
- the agent drawer: revoke an agent;
- the Namespaces view: the Automation panel, with the seat-start switch, the improve loop's switch and its "Runs on" choice (Subscription or API), and the overnight run's switch with its own "Runs on" choice (choosing Subscription records Dustin's decision, its date and its reasoning, docs/overnight.md); one switch per roster namespace, On while it runs and Off while it is paused (pause and unpause); and reset the queue's circuit breaker when it is open;
- the Settings view: add, edit and remove a site, and add, edit and remove a package.

The Queue view shows seat start, and the Agents view the improve mode, as a status word that links to Namespaces.

**The automation switches** (seat start, the improve loop and each namespace's pause; ruled 2026-09-30) do not move when flipped. Each opens a one-line reason beside it: Enter applies, Esc cancels and returns focus to the switch, and an empty reason is an error on the field that sends nothing. A reason is required in both directions, and the Worker refuses `pause`, `unpause`, `mode`, `seat_start` and `overnight` without one. On Apply the app previews and performs in sequence, with no dialog; a refusal is shown beside the switch. Once it applies the switch moves, and the result stays in the message at the foot of the screen, with Undo, until it is dismissed or the next action replaces it (a result with a warning is never replaced; see below). Undo sends the reverse change as its own action with `undo: "true"` and the reason "Undo: " and the original reason (an undone unpause pauses again with the reason it had), and the Worker writes `portal-undo-<action>` for it. Changing "Runs on" while the loop is on is a change of mode and asks for a reason the same way; while the loop is off the choice is held until the switch turns on, starting at Subscription.

Every other control opens a dialog that previews what will change and the audit rows it will write, and nothing happens until its perform button, named for the action ("Revoke agent", "Mark failed", "Pause"), is pressed (the routes are below). For a one-way action (revoke, mark failed, release, remove a site, reset the breaker) the preview puts focus on Cancel. Esc and Cancel close the dialog; a click outside it does not, so a typed reason is not lost. Its result stays in the message until dismissed, and a warning that the click's audit row was not written is part of it. Refresh reads the feed again and runs one watcher pass on demand, at most once per two minutes.

**Warnings and failures stay until dismissed** (capsid/decisions.md 2026-09-30, "admin panels review adopted", item 3). The message region at the foot of the screen holds a stack, newest first. A plain result is replaced by the next one. A result carrying a warning (an audit row naming you was not written, from a control, an Undo or a Refresh's `X-Capsid-Warning` header), an Undo that failed, and a failure (a Refresh, with the Worker's own reason; a copy; a sign out) each stay, whatever happens after them, until their own Dismiss. The missing audit row is the one fact Activity cannot show later, because the missing row is the failure. Only plain confirmations (Copied, the theme, a Refresh that worked or is rate limited) go to the toast that clears itself. For a blocked job the drawer also shows the command and the resume call, with Copy buttons. The command is shown only when its signature matches what the holder's block wrote; a changed one is withheld with a warning, and one written before blocks were signed is shown with an "Unsigned" note under it (`command_signature` in the feed, `src/job-signing.ts`).

## The Overview

The Overview answers one question: does anything need me? It holds, in order:
- six summary tiles, each a link to its view;
- **Needs attention**, the problems only, critical then warnings. Rows of one kind and cause fold into one row that opens in place to its first five, then a link to the full view: "4 pull requests await the seat", "30 jobs are waiting on you". A critical row is never folded. Past eight rows the rest of the warnings wait behind "N more warnings";
- one **Notices** row at the foot of that list, closed, for facts with nothing to do now: a site with no Cloudflare data, the Cloudflare read not configured, a check that could not run, CI that could not be read, site map drift, drivers silent for over 7 days. "Health not read" and "mirror not read" stay warnings, because an unknown backup is not a quiet fact;
- **Sites**, one row per site (status, 7-day uptime, live deploy, errors); every column is in the Sites view;
- **Deploys and downtime, 7 days**.

It has no Queue or Incidents panel: their counts are tiles and their problems are rows. With no site configured there is no site tile, Sites table or timeline. The rules are the UI audit's (`capsid/research/audit-ui-patterns.md`, rulings 1 to 4 and 10). In the Queue, blocked jobs are ordered by priority, then the newest first, and those blocked for over 7 days wait under "Stale"; Done and Failed start closed.

A view with three or more sections that is taller than two screens of the window gets an "On this page" bar of links to them (Deploys in a short window, the Queue with a long list). The Overview is short enough to do without it.


## Its own host

The Portal is served at https://portal.dustinedwards.info, a Custom Domain on the capsid Worker (capsid/decisions.md 2026-10-01, "one address pattern for the family"). It is a separate origin from every public site, so nothing on a public page can reach the Portal's session. `src/portal-host.ts` does it, first in the Worker's fetch (`src/index.ts`), before the OAuth provider, which answers its own routes (`/mcp`, `/token`, `/authorize`, its metadata) without reaching any other handler:

- **The Portal at the root.** On that host a request for `/x` is handled as `/portal/x`, so every Portal route, the gate and every check apply unchanged: `/` is the app, `/api/ops` the feed, `/callback` the sign-in's return.
- **Nothing else.** `/mcp`, `/health` and the `/ops` routes are on https://mcp.dustinedwards.info (`src/mcp-host.ts`). On the Portal host they are Portal paths behind the gate.
- **Old addresses.** A request for `/portal/...` on the Portal host is redirected (308, which keeps the method) to the same path at the root. The built app's hashed files are the exception: they keep their `/portal/assets/` paths on both hosts (the build's `base`), and the Worker serves them as they are.
- **One build, both hosts.** The app reads its base from its own address (`dashboard/src/lib/base.ts`): empty on the Portal host, and `/portal` on any other (the dev server and the test hosts). Its router and every API URL build on it.
- **The domain is managed in the dashboard.** The Custom Domain is added under the Worker's Domains in the Cloudflare dashboard. The deploy config declares no `routes`, so a deploy leaves it in place; a `routes` key added to the config would replace it on the next deploy (Cloudflare's Wrangler configuration docs, "Source of truth"). Another deployment of this repo names its own host in `PORTAL_HOST`.

## Where each view gets its data

The app reads one endpoint, `GET /portal/api/ops`, whose shape is `OpsFeed` in `src/ops-types.ts`. The app and the Worker both typecheck against that file. The feed has three parts.

**The snapshot** is the watcher's last pass, one KV read of `ops:snapshot`. The watcher writes it every 30 minutes, or on Refresh (`src/ops-snapshot.ts`, [autonomy.md](autonomy.md)). It holds:
- each check's result: clear, finding, or could not run;
- Capsid's `/health`;
- the backup mirror;
- each roster repo's latest CI run;
- the site configuration compared with the registered namespaces;
- a probe of every configured site, with a 7-day uptime ring;
- Cloudflare's view of each site, from `src/ops-cloudflare.ts`;
- each configured package as the pass read it, from `src/ops-packages.ts`.

**The live part** is read from D1 and KV on every request. It holds:
- every open job, and every job that ended in the last day;
- the agents and their records;
- pull requests from the last week;
- what auto-merge left for the seat;
- seat-started sessions with their GitHub run links;
- the improve loop's mode and budget;
- each roster namespace's pause reason;
- the site and package configuration;
- the D1 store's size, from the jobs read's `meta.size_after` (every D1 result carries it, so it costs no read of its own).

**The run ledger** is read from D1 on every request too: each scheduled task's five newest runs (below).

Four views read more when they open, and not on every poll:
- **Namespaces** reads `GET /portal/api/namespaces`: each namespace as `improve_status` reports it.
- **Activity** reads `GET /portal/api/activity`: the last 50 audit rows, filtered by namespace and actor. A job transition writes two rows with one action, actor and path, one for the job and one for its mirror document, and the view labels them `(job)` and `(mirror document)`. A row opens a drawer that reads that one row (`?id=`) and shows what it recorded: the reason typed with the change, a field-by-field before and after where the row carries both (the old value struck through above the new), and the row's other fields by name. The Worker turns the params into named fields (`src/audit-detail.ts`) and never sends them raw: a hash, a signature, a token or a nested value is counted as not shown and stays in the audit log.
- **Claims** reads `GET /portal/api/claims`: what agents said beside what the Worker verified (below).
- **Packages** reads `GET /portal/api/packages/history` when a package's history is asked for (below).

## Scheduled tasks

Every scheduled task writes one row per run to `task_runs` (`migrations/0029_task_runs.sql`): which task, when it started and finished, its outcome, and one line on what it did or why it did not. The outcome is `ok`, `skipped`, `refused` or `threw`. Every task goes through `runTask` in `src/task-runs.ts`, the one writer:

- the four cron branches in `src/index.ts`: the backup, the improve opener, the skills refresh and the five-minute tick;
- the five steps the tick carries (`src/improve/tick.ts`): the job lease sweep, auto-merge, the skill evaluation cycle, the watcher pass and the merge-state sweep.

A step that was not due makes no run and writes no row: the watcher between passes, the opener's other UTC hour, the skills refresh on any day but its own, auto-merge under a disabled policy, a lease sweep that returned nothing. A refused merge policy is a run, recorded as `refused`. A ledger write that fails never stops the task; it is logged as `TASK_RUN_UNRECORDED`, and the task then shows as quiet. Rows older than 14 days are pruned, 50 at a time, on each write.

**Incidents** shows every task in the Scheduled tasks panel: its state, its newest run and what it did, with the four runs before it folded underneath. A task is flagged, and listed in Needs attention, when its newest run threw or was refused (Failing), or when a periodic task has had no run in twice its period (Not running): the tick every 5 minutes, the watcher at its own cadence, the backup and the opener daily, the skills refresh weekly. A failing or quiet backup is critical; the rest are warnings. A task with no run recorded yet is shown as No run yet and is not flagged, since every task starts there after the migration. Adapted from Foxhound's cron run history (capsid/decisions.md 2026-09-30, "admin panels review adopted").

## Packages

Optional, like the sites (capsid/decisions.md, 2026-09-29): with no package configured in Settings, the Portal shows no Packages view and the watcher reads nothing for packages. Each watcher pass reads every configured npm package, each source failing on its own (`src/ops-packages.ts`, which cites each API's documentation):
- **Versions**: the registry's abbreviated document, `latest` and the other dist-tags.
- **Downloads**: the last 7 and 30 days from `api.npmjs.org`, and the last 7 days per version, the only per-version counts npm keeps. A package npm has not counted yet shows zero.
- **Dependents**: deps.dev's counts of packages that depend on the default version, directly or through another package. deps.dev calls them indicative, and no public API lists them, so the view links to npm's and deps.dev's lists. GitHub has no API for the repositories that use a package.
- **Repository**: stars, open issues (GitHub counts pull requests as issues; they are taken out), open pull requests (one page of 100; more shows as 100+) and the latest release, through the GitHub App. The first pass of each ISO week keeps these in `ops_package_weeks`.

A pass costs up to nine requests per package. No rate limit is published for npm or deps.dev.

**The daily history** is read when asked for, not pass by pass: from each name's first publish (the full registry document's `time.created`) to yesterday, in ranges of at most 540 days, under npm's 18-month cap, since npm silently shortens a longer range. A package's former name (`formerly`, as enarratio was abscissa) is read the same way and shown joined to it, each day labelled. It is cached six hours in KV (`packages:history:v1:<name>`), about 30 bytes a day. A range npm would not answer is named as missing, never counted as zero.

**Exact times** in a panel or a detail field are shown in the viewer's own time zone with UTC beside it, in a `<time>` element, and need no hover. Rows keep relative times.

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
- **The repo map check** (`src/unmapped-repos.ts`) lists every repo the GitHub App's installations can see and compares it with the namespace mapping. Each repo no namespace maps is one watcher finding (`unmapped-repo-<owner>--<name>`) naming the repo, its visibility, whether it is archived, its last push, and the namespace its name suggests. It never maps: mapping is the authorization boundary and stays with the seat (`update_namespace`). A repo that is unmapped on purpose goes in `capsid/unmapped-repos.md`, one `owner/name` per line (`#` starts a comment); the document can only silence a finding. The listing uses a token minted for the call with the `metadata:read` permission only, held in memory and never stored. A list that cannot be read whole, lists no repos, or sits beside a corrupt mapping is the finding `unmapped-repos-unreadable`, and the check does not count as run, so an open finding is not cleared on no evidence. Every finding states how many repos were read and how many are mapped.
- **The seed** is the list the code held before the move, so nothing changed on the deploy that moved it. Capsid's own row is probed in-process rather than over HTTP; the Portal cannot set that, and an edit that changes Capsid's origin clears it.

## No data is a state, never a zero

A value the feed does not have is shown as **No data** with its reason. It is never a zero, a dash that reads as zero, or a green default.

- **Deploys and errors.** These come from Cloudflare and need `CF_OPS_TOKEN` (below). Until it is set, both columns say "Cloudflare read not configured".
  - A Vercel site says its platform is not Cloudflare.
  - A custom-domain site whose Worker the watcher cannot find says so. Script names are never guessed: a `*.workers.dev` host names its script, and any other host is resolved from the account's Workers custom domains.
  - If the analytics query fails, the error column shows the query's error text.
- **Uptime.** Each half-hour slot the watcher did not run is hatched, not counted as up.
- **Backups.** Capsid's backup age comes from its own `/health`. No other site reports a backup yet: that arrives with each site's `/health` contract, one PR in each site's repo. Until then the column says so.
- **The store's size.** The Backups view's primary panel shows the D1 store's size against the per-database cap, 10 GB on Workers Paid (`D1_CAP_BYTES` in `src/ops-feed.ts`; 500 MB on Workers Free, the one line to change). From half the cap it is flagged there and listed in Needs attention as a warning, Foxhound's threshold (capsid/decisions.md 2026-09-30, "admin panels review adopted", item 5). The size is read in the admin-only feed, not in the public `/health`. A size D1 did not report reads "Not reported", never zero.

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

- **Where:** https://portal.dustinedwards.info, signed in through Cloudflare Access as `ADMIN_EMAIL`. The old address, capsid.dustin-edwards.workers.dev/portal, is retired: every path under it is the plain 404, and capsid-login no longer lists its sign-in callback. **Settings** is the top bar's Settings button, after the theme button, not a view in the left menu; `g` then `e` and the command menu still reach it. **Sign out**, in the top bar, ends the Portal session in this browser. It works at phone width, with a bottom tab bar: Overview, Queue, Incidents, Sites (none when no site is configured) and More, which lists every other view with its count, Settings among them.
- **Keyboard:**
  - `Ctrl K` or `/` opens the command menu. It jumps to any site, job, agent or view, copies a blocked job's command, and reaches every stop: typing "stop" or "pause" lists Turn seat start off, Turn the improve loop off, Pause each running namespace and Revoke each live agent, each only while there is something to stop (capsid/decisions.md 2026-09-30, "admin panels review adopted", item 4). A stop runs its own control and writes nothing itself: a switch's stop goes to Namespaces and presses that switch, so its reason field opens and Undo follows as from a click; Revoke opens the same confirm dialog as the agent drawer. There is no pause-all, which the Worker refuses.
  - `g` then a letter goes to a view: `o` overview, `s` sites, `p` packages, `i` incidents, `q` queue, `d` deploys, `a` agents, `n` namespaces, `l` activity, `v` claims, `b` backups, `c` CI, `e` settings. With no site configured, `s` does nothing, and with no package, `p` does nothing.
  - `j` and `k` move keyboard focus through a list's rows, from the focused row, so the selection is the focused row. Enter opens it. The detail panel is a modal dialog: Tab stays inside it, Esc or a click beside it closes it, and focus goes back to the row.
  - `f` goes to the Queue's text filter. A namespace filter belongs to its view and lives in the address (`?ns=sample`); a list the filter empties says so, with "Show all".
  - `r` refreshes and `t` switches light and dark. The top bar's theme button is named "Dark theme" and is pressed while dark is in effect. **Settings, Display** chooses System, Light or Dark: System removes the saved choice (localStorage `wf-theme`), so the device's setting applies.
  - `[` collapses the side menu to its icons, or expands it (also the button at the foot of the menu). This browser remembers the choice (localStorage `wf-rail`). Collapsed, each icon names its view in a tooltip, and a count shows as a dot.
  - `?` lists the keys. Single-key shortcuts can be turned off with a switch, in that sheet or in Settings, Display; it applies at once (localStorage `wf-single-keys`).
- **Width:** no view scrolls sideways from 1024 px up. The wide tables (Namespaces, the fleet, Agents) turn each row into a card when their panel is too narrow for the columns.
- **Freshness:** the top bar shows when the live part was read and when the watcher's pass ran. The stamp turns to the warning colour when the pass is older than two cadences, which means the watcher has gone quiet. The app polls every 60 seconds while its tab is visible.

## Building and changing it

`dashboard/` is its own package (React 19, Vite, wouter), with its own lockfile and README.
- **Develop:** `npm --prefix dashboard run dev` serves it with fake sample data (`dashboard/dev/sample-feed.json`, checked against `OpsFeed`).
- **Design tokens:** every colour, font and shadow is a custom property from Capsomer, the shared design system (`capsomer` in `dashboard/package.json`, pinned to a release tag; `main.tsx` imports `capsomer/tokens.css`). Capsomer's `tokens/palette.mjs` generates the colours and its own `npm run check` refuses any text or control pair below WCAG 2.2's bar (4.5:1 for text, 3:1 for a boundary) in either theme; `dashboard/e2e/contrast.spec.ts` checks the colours as painted. Capsomer v0.4.0, the pinned release, ships the purple family palette that arrived in v0.3.0 (accent `#8c5fd2`, with `--accent-text` for text, links in `--accent-text`) and replaced the Portal's own seed `#4F2D7F` of 2026-09-30; neutrals and statuses moved a few hex steps and every pair still passes the contrast check. The Portal is excluded from Cloudflare Web Analytics and its page CSP stays strict (capsid/decisions.md 2026-10-03, analytics): it is a private tool, so conventions 7.9 keeps it out of analytics and the CSP names no analytics host. Capsomer's rules sit in `cap.*` layers, so the Portal's own unlayered styles win. Change a colour in Capsomer, never here.
- **Deploy:** `scripts/deploy.mjs` builds it into `dashboard/dist` before every deploy, and the Worker serves those files as its static assets. A failed build stops the deploy.
- **Browser tests:** `npm run test:browser`, after `npm run build:dashboard`, drives the built app in Chromium through Playwright (`dashboard/e2e`). It runs under `vite preview` with the dev mock and the Worker's own page CSP (`src/dashboard-csp.ts`). CI runs it after the build. What it covers:
  - the confirm dialog: every Preview ends in a preview, a refusal, a timeout or a stated reason;
  - the automation switches: no move before the reason is applied, the empty-reason error, Esc, a refusal beside the switch, and the message with Undo that stays;
  - the phone tab bar and its More sheet; Settings in the top bar and under More; the theme button's pressed state, Display's System, Light and Dark, the single-key switch, and exact times in the panel;
  - no sideways scrolling at 1920, 1440, 1280 and 1024 px on every view;
  - the phone layout;
  - the collapsible sidebar;
  - the Claims view: the aggregate, its filter, and a job's claims beside their checks;
  - contrast as painted, in both themes: each text tone, the status words and pills, and a button's border, against what is behind them;
  - the keyboard: `j` and `k` move focus, Enter opens the row and Esc closes it, and the selected row can be seen (a changed background and a ring at 3:1);
  - the audit's eight defects (`e2e/defects.spec.ts`): the panel keeps Tab inside, Enter opens a held job, a namespace filter stays with its view, session incidents reach Needs attention, the confirm dialog's named button and focus, and each view's page title.
- **Size budget:** CI and every deploy run `dashboard/scripts/size-budget.mjs`, which fails closed. The initial JavaScript must be at most 100 KB gzip, each lazily loaded view at most 40 KB, and all CSS at most 12 KB.
- **Assets config:** the `assets` block in `wrangler.jsonc.example` must keep `run_worker_first: true` and `not_found_handling: "none"`, and `test/dry-run-config.test.ts` fails if either changes. Without them the platform could answer a browser's `/authorize` or `/portal/callback` with the app's `index.html`, or serve the app's files without the gate.

## Who gets in

The administrator's Access session, and nothing else (`src/portal-auth.ts`).

- **The sign-in.** The Portal signs in through the same Cloudflare Access for SaaS app and the same `ADMIN_EMAIL` check as the MCP flow ([auth.md](auth.md)), with its own callback at `/portal/callback`, and turns the verified email into a signed cookie, `capsid_portal`, that lasts twelve hours. The check runs again on every request.
- **Cookies.** `capsid_portal`, `capsid_portal_csrf` and the sign-in's `capsid_portal_state` are all `HttpOnly; Secure; SameSite=Lax` and **host-only: none ever carries a `Domain` attribute**, so no other subdomain of dustinedwards.info, the public sites included, can read or set them (capsid/decisions.md 2026-10-01). On portal.dustinedwards.info, a host that serves nothing but the Portal, they are `Path=/`; on workers.dev they are `Path=/portal`, so `/mcp` and `/ops` there never see them. `test/portal-login.test.ts` fails if any of them gains a `Domain` or leaves its host's path. The sign-in returns only to a Portal path; anything else stored as the return lands on the Portal's root.
- **Sign out** (`POST /portal/api/sign-out`, the button in the top bar) expires `capsid_portal` and `capsid_portal_csrf` in this browser. It passes the same checks as an action, so another site cannot sign the administrator out. It ends the Portal session only: the Access session at the team domain is Cloudflare's, so the next visit may sign in again without asking for the email. The cookie is a signed assertion, not a session record, so a copy taken from this browser stays valid until it expires.
- **Machines.** An operator key or an agent key gets a 403 that says so. Those authenticate to `/ops/mcp`, which serves the same state through `improve_status` and `jobs`. A login redirect would send a machine to the Access sign-in.
- **It never merges and it never mints.** Merging can start a CI deploy, so that stays with `manage_pr` behind a caller holding `can_merge`. Minting hands out a key, so that stays with the `agents` tool. Neither is in the Portal's action list, and a test asserts their absence.
- **Each click names where it came from.** A Portal click's audit row (`portal-<action>`, `portal-undo-<action>`) and a Refresh's `portal-ops-refresh` row carry `source_address`: the address the request came from, Cloudflare's `CF-Connecting-IP`, which the edge sets and a client cannot (capsid/decisions.md 2026-09-30, "admin panels review adopted", item 6). A value that is not an IPv4 or IPv6 address is recorded as null, and so is a request with none. The Activity drawer shows it as Source address.

## Routes

Every route but the callback answers to one gate, `portalGate`: the Access session and `ADMIN_EMAIL` on every request, a 403 for any `Authorization` header, and the sign-in for no session. The router matches the callback and every `/portal/api/` route before the app's catch-all.

- **`GET /portal/api/ops`** returns `OpsFeed` (`src/ops-types.ts`), uncached: the watcher's last pass from KV, plus open jobs and jobs that ended in the last day, the agents with their records, pull requests recorded in the last week, the awaiting-seat set, seat-started sessions from the last week with the run each became, and the loop's mode and budget. It also carries each roster namespace's pause reason and the `csrf` value the controls send back. One request costs 13 D1 statements (plus one per unclaimed seat start in the pending window) and 7 KV reads plus one per roster namespace, run concurrently. `src/ops-feed.ts` states them and an integration test counts them.
- **`POST /portal/api/ops/refresh`** runs one watcher pass now and returns the new feed. It needs the header `X-Capsid-Ops: refresh`, which a cross-site form cannot send, and it runs at most once per two minutes (KV `ops:refresh:last`; a 429 with `Retry-After` inside that window, and a 503 when the stamp cannot be read or written). The click is audited as `portal-ops-refresh` under `access:<email>`.
- **`POST /portal/api/actions/preview`** and **`POST /portal/api/actions/perform`** are the fifteen controls (`src/portal-actions.ts`). The confirm is a second request, as ruled 2026-09-11:
  - The preview takes `{action, params}`, reads the current state, writes nothing, and returns what will change, the audit rows the perform will write, and a signed token. The token is good for five minutes and carries the action, its params and the admin's email.
  - The perform takes only `{token}`, so what runs is exactly what the dialog showed.
  - Both refuse a `Sec-Fetch-Site` that is present and not `same-origin`.
  - Both need the header `X-Capsid-CSRF` to equal the cookie `capsid_portal_csrf`. The feed body carries that value, and a cross-site page cannot read the feed.
  - Refusals: 400 refused, 403 CSRF or cross-site, 410 expired (preview again), 413 too large.
  - A perform writes the shared mutator's audit row, then `portal-<action>` under `access:<email>`. Rows from before the move say `console-<action>` ([schema.md](schema.md)).
- **`GET /portal/api/namespaces`** returns each roster namespace as `improve_status` reports it, from the same function. **`GET /portal/api/activity?namespace=&actor=`** returns the last 50 audit rows, filtered, each with its named detail; **`?id=`** returns that one row, and an id that is not a positive whole number is refused with 400.
- **`GET /portal/api/claims`** (`src/portal-claims.ts`) returns the per-agent aggregate, filtered by `namespace`, `agent`, `since` and `until` (ISO times; anything else is a text 400), or with `?job=<id>` one job's claims, checks and touches, and a JSON 404 for a job that does not exist. It reads through the `claims` tool's readers and writes nothing.
- **`GET /portal/api/packages/history?name=`** (`src/portal-packages.ts`) returns one configured package's daily downloads, joined to its former name's, and its weekly GitHub rows (`PortalPackageHistory`). A name that is not configured is a 404, so the route cannot fetch an arbitrary package from npm.
- **`POST /portal/api/sign-out`**, above.
- **Any other `/portal/api/` path** is a JSON 404 behind the gate, never the app's page.
- **`/portal/`** and everything under it serves the built app from the `ASSETS` binding, only after the gate. The page gets `no-store` and its own CSP (scripts, styles and fetches from this origin only); hashed files under `/portal/assets/` are cached privately for a year. A browser loading an unknown path as a page gets the app's page, so the app's own routes load; a missing file stays a 404. With no `ASSETS` binding the admin gets a 503 saying the Portal is not deployed.
- **Deploy config.** The Worker's `assets` block must set `run_worker_first: true` and `not_found_handling: "none"`. Without `run_worker_first`, Cloudflare serves any request that matches a file in the assets directory (its `/index.html` and `/assets/*`, at the root of the origin) without running the Worker, so without the gate. The integration pool calls the Worker directly, not through the assets router, so no request-level test can see the setting; `test/dry-run-config.test.ts` fails instead if `wrangler.jsonc.example` loses either value.
- **Seat-start runs.** A `repository_dispatch` returns no run id, so the run is learned when the runner trades its OIDC token at `/ops/runner-key`: the `runner-key-minted` audit row records the token's `run_id` claim and the run's URL, and the feed joins it to the start.
- **The live check.** `scripts/verify-live.mjs` gate 6 asserts `/portal/` answers an anonymous caller with the sign-in (302), and that `/console`, `/console/app/` and `/console/callback` each answer 404. Gate 7 asserts that https://portal.dustinedwards.info/ and its `/mcp` answer an anonymous caller with a 302 to the Access team domain: never the app, and never the MCP endpoint. It reads `PORTAL_ORIGIN` when set.

**What needs Dustin, per app.** GET /ops/inbox (src/inbox.ts) answers, for each configured app (the ops_sites rows, plus any namespace with something waiting), a count, a severity (needs-you, failing or none) and the items behind it: blocked jobs and questions, pull requests auto-merge declined, a failing CI run, a site that is down. It is read by each app's server with a key, not by a browser: a key scoped to one namespace sees that app alone, the admin sees every app, and the response carries no CORS headers and is cached for 30 seconds privately. improve_status carries the same answer per namespace as needs_dustin. What an app only it knows (Carrel's drafts waiting) is designed in capsid/research/design-inbox-report.md and not built.
