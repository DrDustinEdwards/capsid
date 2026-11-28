# Capsid Portal

The administrator's view of Capsid, one app at https://portal.dustinedwards.info: every site, the watcher's findings, deploys, agents, namespaces, activity, backups and CI.

## Controls

The controls are the registry in `src/controls.ts` (`PORTAL_ACTIONS` in `src/controls-base.ts`), each on the row it changes:

- Chat only: close a pull request without merging it (`pr_close`, with a reason, through `capsid_admin_run_controls`), as `capsid_close_pr` action `close` does, head-branch cleanup included; GitHub can reopen it.
- The agent drawer: activate a newly minted agent (`activate_agent`; its key resolves nothing until then, [auth.md](auth.md)) and revoke an agent.
- Sites: add a site; on a site's Setup tab, edit and remove it (`site_add`, `site_edit`, `site_remove`) and rotate its operator key (`site_key_rotate`, "Site keys" below); on its Sync and repairs tab, run a repair (`site_repair`). The Sites panel of Health's Backups tab has `site_backup` and `run_job` ("Site backups").
- Packages, its Shared tab: add, edit and remove an npm package (`package_add`, `package_edit`, `package_remove`).
- Projects: add (`namespace_add`: the namespace and its repo, or a repos JSON array with exactly one `primary`), change the repo mapping (`namespace_edit`, the whole mapping as it will be; the preview binds the mapping it read, so an edit made in between is refused) and delete (`namespace_remove`, with `cascade` and `allow_improve_paths` as `"true"` where needed). They are `capsid_admin_manage_namespaces` actions `register`, `update` and `delete_preview` then `delete_perform`, through the same functions (`src/namespace-admin.ts`, `src/namespace-delete.ts`) and with the same refusals ([schema.md](schema.md), "Deleting a namespace"). No driver agent is minted: that stays with `capsid_admin_manage_agents`.

**Portal-only controls.** Chat runs the same controls through `capsid_admin_run_controls`, except `site_key_rotate` and `activate_agent`, which it refuses at preview and perform (`PORTAL_ONLY` in `src/controls-base.ts`). Every project thread is the admin, so a thread could be talked into setting a site key or activating a key it minted by text it read; a click in the signed-in Portal is a person.

Every control opens a dialog that previews what will change and the audit rows it will write, and nothing happens until its perform button, named for the action ("Revoke agent", "Remove site"), is pressed. For a one-way action (revoke, remove a site, delete a project, rotate a site key) the preview puts focus on Cancel. Esc and Cancel close the dialog; a click outside does not, so a typed reason is not lost. The confirm dialog says what the action does in a sentence; the rows it changes and the audit rows it writes are behind "Details". Refresh reads the feed again and runs one watcher pass on demand, at most once per two minutes.

**Warnings and failures stay until dismissed.** The message region at the foot of the screen holds a stack, newest first. A result carrying a warning (an audit row naming you was not written, from a control or a Refresh's `X-Capsid-Warning` header) and a failure (a Refresh, a copy, a sign out) each stay until their own Dismiss: the missing audit row is the one fact Activity cannot show later. Plain confirmations (Copied, the theme, a Refresh that worked or is rate limited) go to a toast that clears itself.

## Pages

- **Now:** Board and Health.
- **Work:** Memory, Pull requests and Projects.
- **Sites:** Sites (`/portal/sites`), one page for each site (`/portal/sites/<namespace>`), and Packages (its Shared and Completeness tabs).
- **Access:** Agents, with Roster, Activity, Archive and AI access tabs. Roster lists live agents only. Archive (`?tab=archive`) lists the revoked ones: those the watcher has archived with when and why, and those still waiting their 7 days with the date they move ([auth.md](auth.md)). AI access links each MCP server's owner page, where your grants to AI clients can be revoked and its tool-call log read. Roster and Archive read the feed's `agents`, the inventory `capsid_read_status` action `status` serves.
- **Settings**, the menu's last entry and under the avatar: phone alerts, the daily digest and this browser's display.

A page's tab is its `?tab=`, and a reference in the code names a page and tab as `page#tab` (`placePath` in `dashboard/src/app/ctx.ts`). The Portal keeps no redirect or alias for a page that moved.

On a phone the tab bar is Board, Health and Pull requests, and the header's menu button lists every page with its count. Every risky control (Remove, Revoke) sits alone in a red "Danger" area. A page with three or more sections taller than two screens gets an "On this page" bar.

### Board

Board is the home page (`/portal/`), the answer to "what do I have to decide". It holds, in order:

- **Waiting on you**: each open handoff's "Waiting on Dustin" section, then the inbox (`GET /ops/inbox`, `src/inbox.ts`, carried as `live.inbox`). The header's inbox count is this list's number.
- **Problems**, critical then warnings, without what already waits above (a site down and CI failing are inbox items). Rows of one kind and cause fold into one row that opens in place to its first five; a critical row is never folded. Past eight rows the rest of the warnings wait behind "N more warnings". One closed **Notices** row at the foot holds facts with nothing to do now. "Health not read" and "Amazon copy not read" stay warnings, because an unknown backup is not a quiet fact.
- **Pull request trouble**: open pull requests with red CI or a conflict, and pairs that change the same file, from `GET /portal/api/prs`.
- **Open handoffs**: a progress ring of checklist items done, and a table of them, newest first, each a link to its document on Memory.
- **Threads**: threads per day over 21 days, stacked as the top five projects and Other, and the ten most recent.

Board's own read is `GET /portal/api/board` (`src/portal-board.ts`): open handoffs, their "Waiting on Dustin" sections and the thread ledger, from D1, live. Titles another thread wrote are shown as text.

In chat, `capsid_admin_whats_next` (`src/whats-next.ts`, admin only, read-only) answers the same question: every open pull request in every mapped repo with its CI verdict and whether it conflicts, and the watcher's checks that found something or could not run. A part it could not read is named in `not_checked`. It and `GET /portal/api/prs` share one reader (`readOpenPrs`).

### Sites

**Sites** (`/portal/sites`) has two tabs. All sites: Add site, one table of every site (status, uptime, live deploy, errors in 24 hours, backup age, probe), each row opening the site's page; each site's uptime by month; and the projects recorded as serving no site. Deploys (`?tab=deploys`): every site's deploys over a range, on a timeline and in one table, as Cloudflare recorded them (so a hand-run `wrangler deploy` shows up); the sites with no deploy data; and each repository's deploy measures.

**A site's page** has five tabs: **Overview** (its probe, uptime strip, error rate and uptime by month), **Deploys** (what Cloudflare recorded, then its Workers Builds, each with Log for the build's last 500 lines), **Search and traffic** (`?tab=traffic`: Google Search Console and Bing Webmaster over the same 28 days, and Cloudflare's edge over 7 days: missing pages, server errors, web vitals at the 75th percentile, and AI crawlers; Capsid's own page adds its 404 table with the hosts that linked to each path), **Sync and repairs** (`?tab=sync`) and **Setup** (`?tab=setup`: its settings row with Edit and Remove, its Worker secrets by name, Rotate key where it has an operator API, and what each of its Workers binds). Each source with no data says why: not configured, nothing in the window, or the read failed. A site's Workers are its own script and every Worker its system lists beside it in `system/model.json`.

**Projects** lists each project with its driver and the integrity of its latest truth report, the repos it maps and Edit (its repo mapping, and Delete under Danger). Add project registers a new one.

### Health

**Health** (`/portal/health`) answers "is anything broken". It holds one line ("All good", or how many problems and the first three by name, each a link to where it is fixed, then "N more" to Board's list, so the two pages never disagree); four tiles, each a link to its tab (Sites up, Open findings, Backup, and Amazon copy, the oldest of the sites' newest off-account copies, so a stale copy never turns a good backup red); and five tabs, the choice in `?tab=`: **Problems** (the watcher's findings and the daily maintenance pass's list), **Backups**, **CI** (the default branches), **Scheduled tasks** (`?tab=scheduled`) and **Cloudflare** (`?tab=resources`: the Workers no site owns, and every D1 database, KV namespace and R2 bucket with who uses it). Its menu count is the number of critical problems, leaving out what waits on you. One namespace filter in the address (`?ns=`) narrows every tab. With no site configured there is no site tile.

### Memory

The knowledge store, read-only, in tabs: Handoffs (the default), Decisions, Rulings, Research and Search. Writing stays in chat and with drivers. `GET /portal/api/library` (`src/portal-library.ts`) answers one of three ways by its query string:

- **No argument:** the shelves over every namespace. Handoffs are paths under `handoff/`, newest first, at most 300, each marked open when written in the last 14 days; the tab draws handoff writes per week over 12 weeks and the year's document writes as a calendar. Decisions are documents of type `decision`; Rulings are paths under `rulings/`; Research is paths under `research/`. Nothing under `archive/` is shelved. One statement walks the unique index and stops at 500 rows; past that the page says to search.
- **`?q=`:** full text search over every namespace, the best 25 by bm25, with the matched words marked. A query FTS5 refuses is retried as a phrase.
- **`?ns=&path=`:** one document, its text as written, and the typed edges declared on it and pointing at it.

Search, the read and the edges go through `src/doc-reads.ts`, the readers `capsid_find_docs` and `capsid_read_doc` use, so Memory and chat cannot disagree. The route writes nothing, not even the conventions-read row. The page's state is in its address (`?q=`, `?doc=<namespace>/<path>`).

## Its own host

The Portal is served at https://portal.dustinedwards.info, a Custom Domain on the capsid Worker, a separate origin from every public site, so nothing on a public page can reach its session. `src/portal-host.ts` handles it first in the Worker's fetch (`src/index.ts`), before the OAuth provider:

- **The Portal at the root.** On that host a request for `/x` is handled as `/portal/x`, so every Portal route, the gate and every check apply unchanged.
- **Nothing else.** `/mcp`, `/health` and the `/ops` routes are on https://mcp.dustinedwards.info (`src/mcp-host.ts`); on the Portal host they are Portal paths behind the gate.
- **Old addresses.** A request for `/portal/...` on the Portal host is redirected (308) to the same path at the root. The built app's hashed files keep their `/portal/assets/` paths on both hosts.
- **One build, both hosts.** The app reads its base from its own address (`dashboard/src/lib/base.ts`): empty on the Portal host, `/portal` elsewhere (the dev server and the test hosts).
- **The chart demo, the one public page.** `/demos/` is the app's second route tree (`dashboard/src/routes.ts`) with sample data only: `dev/sample-feed.json` and the dev mock's answers, captured at build time into `/demos/api/*.json` (`npm run build:demo`) and moved to the current time as they are read. `src/portal-demo.ts` serves it before the gate, GET and HEAD only, noindex; it reads nothing from Capsid and writes nothing. It exists so the live chart check (devkit `live/areas.json`, area 10) and a visitor can see the charts.
- **The domain is managed in the Cloudflare dashboard** under the Worker's Domains. The deploy config declares no `routes`, because a `routes` key would replace it on the next deploy. Another deployment of this repo names its own host in `PORTAL_HOST`.

## Where each view gets its data

The app reads one endpoint, `GET /portal/api/ops`, whose shape is `OpsFeed` in `src/ops-types/feed.ts`. The app and the Worker both typecheck against `src/ops-types/`. The feed has three parts:

- **The snapshot**: the watcher's last pass, one KV read of `ops:snapshot`, written every 30 minutes or on Refresh (`src/ops-snapshot.ts`, [autonomy.md](autonomy.md)).
- **The live part**, read from D1 and KV on every request: the agents, the site and package configuration, the inbox and the watcher's open findings, and the D1 store's size (`meta.size_after`).
- **The run ledger**: each scheduled task's five newest runs.

These read more when they open, not on every poll:

- **Health's Problems tab** reads `GET /portal/api/maintenance` for the Maintenance panel: the daily maintenance pass's last list (broken things first, then what waits on the seat, tidying, what the pass did on its own, what it could not read).
- **Projects** reads `GET /portal/api/namespaces`: each namespace as `capsid_read_status` action `status` reports it, with its repo mapping.
- **Agents' Activity tab** reads `GET /portal/api/activity`: the last 50 audit rows, filtered by namespace and actor. A row opens a drawer (`?id=`) showing the reason typed with the change, a before and after where the row carries both, and its other fields by name. The Worker turns the params into named fields (`src/audit-detail.ts`) and never sends them raw: a hash, a signature, a token or a nested value is counted as not shown.
- **Packages** reads `GET /portal/api/shared-code` and `GET /portal/api/completeness` ("Shared packages", "Completeness").
- **A site's Setup tab** and **Health's Cloudflare tab** read `GET /portal/api/resources`: the secrets and data model the nightly build stored ([public-data.md](public-data.md)), names only, one panel per Worker, and on Health every D1 database, KV namespace and R2 bucket with who uses it and a warning on any store no Worker binds.
- **Memory** reads `GET /portal/api/library`.
- **Pull requests** reads `GET /portal/api/prs` in the browser: every open pull request in every mapped repo, oldest first, with CI verdict, conflict and same-file overlaps, read through the GitHub App and kept in KV for 15 minutes (`portal:prs:v1`). A read that reached no repo is not kept.
- **The server-drawn charts** come from `GET /portal/api/figures?set=`.

**Exact times** are shown in the viewer's time zone with UTC beside them. **Relative times** ("2m ago") use the server's clock: the app takes the skew between its clock and the feed's `generated` time. A timestamp with no zone is read as UTC.

## Scheduled tasks

Every scheduled task writes one row per run to `task_runs`: which task, when, its outcome (`ok`, `skipped`, `refused` or `threw`) and one line on what it did. `runTask` in `src/task-runs.ts` is the one writer, and `TASKS` there lists the tasks. They are the two cron branches in `src/index.ts` (the backup and the five-minute tick) and the steps the tick carries (`src/tick.ts`), among them the watcher pass. A step that was not due makes no run. A ledger write that fails never stops the task; it is logged as `TASK_RUN_UNRECORDED`. Rows older than 14 days are pruned, 50 at a time, on each write.

Health's **Scheduled tasks** panel shows each task's state, newest run and what it did, with the four runs before it folded underneath. A task is flagged and listed in Problems when its newest run threw or was refused (Failing), or when a periodic task has had no run in twice its period (Not running). A failing or quiet backup is critical; the rest are warnings. A task with no run recorded yet is No run yet and not flagged.

## Packages and charts

The npm package list, `ops_packages`, is edited at the top of the Packages page's Shared tab through the same preview and perform as sites (`src/ops-package-config.ts`). The versions table reads it; nothing else does.

### Trends

`GET /portal/api/trends?weeks=` (`src/trends.ts`, `src/portal-trends.ts`) serves the series the feed does not carry. Admin only, read-only. `weeks` is 1 to 26, default 8; every time is UTC and weeks start on Monday.

| Series                                                                                                                | Drawn in                             | Read from                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minutes`: per ISO week, minutes and sessions                                                                         | a tile on Agents' Activity tab       | `audit_log` rows by an `access:` actor, split into sessions at a 5-minute gap, each its span plus 1 minute. An estimate: reading the Portal writes nothing, so it is not counted                                                                                |
| `deploys`: per repo, per week, shipped, refused, rolled back, unverified, change failure rate, median time to restore | the CI tab's table                   | `deploy_outcomes`: `verified` shipped; `rolled_back`, `rollback_failed` and `rollback_skipped` refused; the rate is refused over shipped plus refused; restore is the median `restore_seconds` of the rolled-back rows                                          |
| `backups`: 14 daily, 4 weekly and 3 monthly slots, filled or not                                                      | three strips in Health's Backups tab | the complete runs (`_complete.json`) under `backups/json/` in the backup bucket                                                                                                                                                                                 |
| `ci`: per roster repo and day for 14 days, green, red or none                                                         | a heat strip per repo in the CI tab  | GitHub, each repo's default-branch runs; a day is red when any workflow's last completed run up to then failed. Kept in KV for an hour (`portal:trends-ci:v1`) only when every repo was read; a repo that could not be read is in `not_read`, never drawn green |

A site's error rate (with a marker at each deploy and the 1% alert) and uptime come from the feed. Tests: `test/trends.test.ts`, `test-integration/portal-trends.test.ts`.

Charts are drawn in the browser with Enarratio's primitives (`dashboard/src/views/TrendCharts.tsx`) as a whole figure (title, finding, caption, source, toolbar, data table) in Capsomer's `ChartFrame`, which redraws it to its width; a chart with no data is the frame's no-data state, and one Enarratio refuses to draw says why. Enarratio's markup carries no inline style, so it passes the page's CSP; `enarratio/base.css` is mapped to the Portal's tokens in `styles.css`, so both themes follow. The bar, line and area charts use `enarratio/lite` to stay under the 40 KB chunk budget. A chart that needs meaning in its colors sets the variables in a class (`.agree-chart`), because a per-chart color option would write an inline style the CSP refuses. The Sites table's errors per hour are an Enarratio sparkline, Sites' Deploys tab is an Enarratio timeline, a site's uptime is Capsomer's uptime strip and backup age is Capsomer's meter. Only the shell's countdown ring is hand-drawn.

### Server-drawn charts

`GET /portal/api/figures?set=memory|agents|roster` (`src/portal-figures.ts`, drawn by `src/figures.ts`) serves the charts that need Observable Plot (`enarratio/plot`, imported inside the read, never at the Worker's start), drawn on the Worker as HTML with no style attribute and kept in KV for ten minutes (`portal:figures:<set>:v1`). Each figure carries its finding as the text alternative and its data table; a set with no data names why in `empty`, and a part it could not read is in `not_checked`. Admin only, read-only.

- `memory`: the year's document writes as a heatmap (weekdays down, 52 ISO weeks across; on a phone the last 13 weeks), and handoff writes per ISO week over 12 weeks, the top five projects and Other.
- `agents`: who acted over 30 days, one row per actor and client, the top ten and Other, as a heatmap by day on a wide screen and by week on a phone.
- `roster`: the same counts with no figure, for the Roster tab's sparklines and bars.

In every heatmap a zero is an outlined empty cell and the five steps sit at the quintiles of the non-zero values, so one busy row cannot wash out the rest. Health's Findings list shows how long each finding has been open as a bar, and its Backups tab each site's backup and Amazon copy age as Capsomer meters against their targets. Tests: `test/figures.test.ts`.

### Shared packages (Packages, Shared tab)

How far the centralization has got: one panel per row of `shared_packages` (seeded with Capsomer, site-api, d1-dump, Prelum, site-runtime and devkit, each with its repo's earlier names and the known local copies it replaces). A panel shows the package's newest release tag, every app that pins it with the tag and how many releases behind it is ("Current", "2 releases behind", "Unpinned" for a branch or a bare preset), whether it is pinned through the repo's old name, and each known local copy as still there or removed. Its header gives the version in the package repo's own `package.json` on the default branch, marked "untagged" while no tag names it, and, unless that file is private, npm's latest dist-tag.

`src/shared-code.ts` reads through the GitHub App the watcher uses. The apps are every repo the system model lists, each on its default branch: one recursive tree, every `package.json` outside `node_modules` (at most 16) with its nearest lockfile, every workflow's pinned `uses:`, and the Renovate config for presets. The pinned version is the lockfile's, else an exact spec or a git ref. The nightly `system-facts` build writes the answer to KV (`portal:shared-code:v3`, 36 hours) and the tab reads that, so the tab and the versions model ([public-data.md](public-data.md)) are one read. With no table yet it says the migration is the seat's to apply. Nothing on the tab changes anything. Tests: `test/shared-code.test.ts`, `test-integration/shared-code.test.ts`, `dashboard/e2e/shared.spec.ts`.

### Completeness (Packages, Completeness tab)

devkit's completeness scoreboard: each of the 12 areas of the shared code against the package and every live site, as complete, partial, missing or does not apply. devkit decides every cell (its README, "The scoreboard"); Capsid only reads the result. `src/completeness.ts` reads `board.json` from devkit's `scoreboard` branch through the GitHub App, keeps only the fields it names (bounded, and only https proof links) and caches it in KV for ten minutes (`portal:completeness:v1`). The tab shows a verdict line, the grid of areas by sites, and a panel per area: who built it, who verified it, lines added and removed, and each cell that is not complete with its reason, first errors and proof. A board that cannot be read says why. Test: `test-integration/completeness.test.ts`.

## Sites are configuration

Which sites the Portal watches is configuration each install edits, not code. The rows live in the D1 table `ops_sites` (`src/ops-sites.ts`) and are edited on **Sites**: Add site there, and Edit and Remove on each site's Setup tab.

- **A row per namespace.** A row with an origin is a site: its name, origin (`https://` and a hostname, nothing else), an optional health route, its platform (`cloudflare` or `vercel`), and optionally the Worker script that serves it. A row with no origin records that the namespace serves no site. A row keyed `<namespace>-<host>` (capsid-portal, foxhound-admin-mcp) is a further host of that namespace: probed and alerted like a site, not reported as an unregistered namespace.
- **Edits are controls.** Add, edit and remove go through the same preview and perform as every control. The preview names every field that changes. An edit or removal carries the row's `revision` from the preview and is refused if the row changed since. Each writes `ops-site-added`, `ops-site-edited` or `ops-site-removed` (with the row before and after) and then the click row.
- **What is checked.** The origin must be `https://` and a lowercase public hostname: no user, port, path, query or fragment, no IP address, no single-label or local name. A health path starts with `/` and uses only letters, digits and `- . _ ~ /`, with no empty, `.` or `..` segment. A script is named only for a Cloudflare site. A new row's namespace must be registered.
- **Nothing configured.** With no row that has an origin, the watcher probes nothing and reads nothing from Cloudflare, and Health shows no site tile.
- **Every pass reads it.** If the read fails, no site check runs that pass: nothing is probed on a guess and no open site finding is cleared.
- **A check on demand.** `capsid_inspect_repo` action `site` (`src/site-check.ts`) reads one namespace's site on its own origin only: the health route as the watcher probes it, one page (status and security headers), and one path that must refuse a caller with no credential. It returns statuses and verdicts, never body text.
- **The site map check** compares the rows with the registered namespaces both ways; a mismatch is a watcher finding.
- **The repo map check** (`src/unmapped-repos.ts`) lists every repo the GitHub App's installations can see and compares it with the namespace mapping. Each unmapped repo is one finding (`unmapped-repo-<owner>--<name>`) naming its visibility, whether it is archived, its last push, and the namespace its name suggests. It never maps: mapping is the authorization boundary and stays with the admin. A repo unmapped on purpose goes in `capsid/unmapped-repos.md`, one `owner/name` per line (`#` starts a comment); the document can only silence a finding. The listing uses a token minted for the call with `metadata:read` only, held in memory. A list that cannot be read whole, lists no repos, or sits beside a corrupt mapping is the finding `unmapped-repos-unreadable`, and the check does not count as run.

## Site repairs

A site may let Capsid call an allowlist of its own repair tools, so its convergence view, repair buttons and watchdog live in Capsid. A site opts in through the `operator` column of its `ops_sites` row (`src/site-operator.ts`), a JSON object of `path` (the operator route on its origin), `auth_var` (the name of the Capsid Worker secret holding its operator token, which must be `<NAMESPACE>_OPERATOR_TOKEN`, or that of the namespace a further host belongs to), `repairs` (health check name to repair tool, in repair order), `weekly` (tools the watcher runs once a week), `secrets` (names of the site Worker's secrets to report) and `backup` (true lets Capsid Admin's backups call it). `site_edit` through `capsid_admin_run_controls` sets it (`operator`, or `none` to clear it); the Setup tab shows it, its form does not set it, and an edit that does not name it leaves it. An edit that moves a row's origin while it names a token is refused, because the token would go to the new host.

- **Two allowlists, both in the Worker, checked before every request.** The ceiling, in code: a repair is a `sync_*` tool other than `sync_status`, or `refresh_citations`; a backup is `backup_status` or `run_job { backup: true }`, called only by the backups and only where the site sets `backup: true`; a job run is `run_job { job }`, called only by the `run_job` control. No write tool the site's operator API serves is ever called. Then the site's own list: the tools its `repairs` and `weekly` name. A configuration that breaks the ceiling is refused whole when saved, and a stored one is checked again before each call. `test/site-operator.test.ts` and `test-integration/site-repair.test.ts` hold it.
- **The token** is read by name from the Worker's environment, sent only to the site's own origin, never logged, returned or put in an audit row. Unset, nothing is called and the Portal says so.
- **Run repair** is the control `site_repair` (`namespace`, `tool`). Each call that leaves the Worker writes an `audit_log` row (`site-repair`, with the tool, the surface, the HTTP status and the site's read-back verdict) and a `task_runs` row.
- **The rate limit** (`src/site-repair.ts`), per site and tool: any call waits 2 minutes after the last; the watcher waits 30 minutes and makes at most 4 calls a day, after which only a person can run it and the incident says so.
- **Sync and repairs** (`GET /portal/api/convergence`): for an opted-in site, its operator API's `sync_status` and its health route's checks, read live, each failing check with the repair it maps to and a Run button, the weekly tools and the last repairs. Its Setup tab shows the site Worker's secrets by name from the watcher's pass (`GET /accounts/{id}/workers/scripts/{script}/secrets` with `CF_OPS_TOKEN`); a value is never read.
- **The watcher** (`src/site-watch.ts`), each pass: reads the health route; when every failing check maps to an allowlisted repair it runs them in order and reads the health again (when every repair converged and the read still fails, up to three more times thirty seconds apart, since a rewritten store can list short for a minute); when a failing check maps to nothing, it repairs nothing, because a failure with an unmapped part may share its cause. Still unhealthy, or a repair failed: the finding `site-health-<namespace>` opens and clears when a pass finds the site healthy. A weekly tool runs once every 7 days; a failure is `site-weekly-<namespace>-<tool>`. The phone alert for a site going down or back up comes from the tick's `site-pulse` step (below).

## Site backups

Checking every site's backups and backing up now are Capsid Admin's: one control for every site in place of a tool on each site's own admin MCP (`src/site-backup.ts`). Each site keeps its nightly cron (d1-dump's `runCheckedBackup` and `backupFiles`); Capsid reads what it left and runs the files passes on demand through the site's operator API, on every site whose `operator` sets `backup: true`. A further host of a site (`carrel-mcp`) stands for the site: its backups show the site's Amazon copy.

- **Check** is `capsid_admin_read_ops` action `backups` and the Sites panel of Health's Backups tab (`GET /portal/api/backups`): each such site's `backup_status` read live (the newest complete D1 dump and each files pass, with the site's own warning past 26 hours) beside its newest Amazon copy, Capsid's own dump, and the sites with an Amazon copy not configured yet. Reads only, not audited.
- **Back up now** is the control `site_backup` (`namespace`, or none for every such site), calling `run_job { backup: true }`: the site runs its own backup jobs through the path its nightly cron runs, recorded in its `cron_runs`. Each call writes an `audit_log` row (`site-backup`) and a `task_runs` row and waits on the repairs' rate limit. With `namespace` `capsid` the control asks for Capsid's own dump instead (`queueCapsidJob`, `src/site-jobs.ts`) and answers at once: the next tick runs the nightly cron's run in its own scheduled invocation, which has the cron's 15-minute wall, and records it as the `backup` task. It never runs inside the click's request, which the platform cancels when the client disconnects.
- **Run a job now** is the control `run_job` (`namespace`, `name`): any job a site's cron runs, through its operator API's `run_job` (site-runtime `runJobTool`, the same path and `cron_runs` record as the trigger), or, with `namespace` `capsid`, one of Capsid's own nightly jobs (`backup`, `tool-call-log-export`, `supersede`; `src/site-jobs.ts`), queued for the next tick. An admin MCP server is its own site row (`dustinedwards-admin-mcp`, ...) whose job is `tool-call-log-export`. Each call writes an `audit_log` row and a `task_runs` row (`site-job`) and waits two minutes per job per site.

## Site keys

A site's operator key is the site API's key (DrDustinEdwards/site-api): the site's Worker holds it as `CARREL_SITE_KEY`, and Carrel holds the same value as `SITE_<NAMESPACE>_KEY` (upper case, dashes as underscores). The control `site_key_rotate` (`namespace`, `src/site-key.ts`), on a site's Setup tab, mints a new one and sets it on both sides through the Cloudflare API. It runs only from a click in the Portal ("Portal-only controls"). Its preview refuses when there is no `CF_SECRETS_TOKEN` or the site row names no Cloudflare Worker script, and mints nothing. Its perform writes `set_site_key`, then the click row with whether each side was set, never the value.

- **The value is never shown**: not returned, logged, audited or put in an error. It exists in that call's memory and in the two secrets.
- **The token** is `CF_SECRETS_TOKEN`, a Cloudflare API token apart from `CF_OPS_TOKEN` because it can write: **Account / Workers Scripts / Edit**. The account is `CF_ACCOUNT_ID`, or `R2_ACCOUNT_ID` where that is unset. A 403 from Cloudflare says the token needs that permission.
- **The order.** The site's Worker first, then Carrel. When the site refuses, nothing changed and Carrel is not touched. When the site takes the key and Carrel does not, the answer says the two sides differ and Carrel's calls to the site are refused until they match; calling again mints a fresh key and sets both. Nothing is retried silently.

## No data is a state, never a zero

A value the feed does not have is shown as **No data** with its reason, never a zero, a dash that reads as zero, or a green default.

- **Deploys and errors** come from Cloudflare and need `CF_OPS_TOKEN`; until it is set both columns say "Cloudflare read not configured". A Vercel site says its platform is not Cloudflare. A custom-domain site whose Worker the watcher cannot find says so: script names are never guessed. If the analytics query fails, the error column shows its error text.
- **Uptime.** Each half-hour slot the watcher did not run is hatched, not counted as up.
- **Backups.** Capsid's backup age comes from its own `/health`; other sites' from "Site backups".
- **The store's size** is on Health's Backups tab against the per-database cap, 10 GB on Workers Paid (`D1_CAP_BYTES` in `src/ops-live.ts`). From half the cap it is a Problems warning. A size D1 did not report reads "Not reported".

## The Cloudflare token

`CF_OPS_TOKEN` is a read-only Cloudflare API token. The watcher needs **Account Analytics Read** (requests and errors per Worker per hour) and **Workers Scripts Read** (deployments, the custom-domain list, and the secret names of a site that opted into repairs). More permissions enable more reads; until each is there, that part says the read failed or the action refuses with a 403 naming it:

- **Account / Account Settings / Read**: the Web Analytics sites list for the `analytics` live check ([live-checks.md](live-checks.md)); without it the rule files `live-analytics-unread-<site>`.
- **Zone / SSL and Certificates / Read** and **Zone / Zone / Read**: each zone's certificate packs for the certificate-expiry alert; without them no expiry alert can fire.
- `capsid_admin_read_ops`'s Cloudflare configuration actions (`src/tools/cloudflare.ts`): **Account / Access: Apps and Policies / Read** (`access_apps`, `access_policies`), **Account / Email Routing Addresses / Read** (`email_addresses`), **Zone / Zone / Read** and **Zone / Email Routing Rules / Read** (`email_rules`). The tool copies named fields only, so an Access client secret, a SCIM credential or an application's aud tag never reaches the caller, and it runs once per tool call, never from a Portal page.
- The nightly secrets and data model ([public-data.md](public-data.md)): **Account / D1 / Read**, **Account / Workers KV Storage / Read** and **Account / Workers R2 Storage / Read**.
- `builds` and `build_logs` (`src/workers-builds.ts`): **Account / Workers CI / Read**.

To add permissions to the existing token (`capsid-portal-read`), open dash.cloudflare.com/profile/api-tokens, choose Edit, add them, set Zone Resources to all zones from the account, and update the token. The secret value does not change. The account id comes from `CF_ACCOUNT_ID`, or `R2_ACCOUNT_ID` where that is unset. The watcher calls Cloudflare once per pass, never per page load.

## Phone alerts

Settings has a **Phone alerts** panel (`dashboard/src/views/PhoneAlerts.tsx`). **Turn on for this device** asks the browser for notification permission, registers the Portal's service worker (`dashboard/public/sw.js`, which shows an alert, opens its item on a tap and caches nothing), subscribes with the VAPID public key and stores the subscription in `push_subscriptions`. Each device can be turned off from the list, and **Send a test alert** sends one to every device and shows each push service's answer.

The tick's `push` step (`src/push.ts`) sends an alert for three things only:

1. a rollback or failed rollback recorded in `deploy_outcomes` in the last day;
2. a site, from the tick's `site-pulse` step (`src/site-pulse.ts`), which probes every site's health route every five minutes the way the watcher does and keeps its state in KV `site-pulse:state`: down on two probes in a row (once per outage, naming the reason), back up after that (once), and degraded (health body reporting warn, `ok: false` or a backup warning; once a UTC day while it lasts);
3. a TLS certificate on a watched host that expires within 21 days and again within 3 (`src/tls-expiry.ts`), and a domain registration that expires within 30 days and again within 7 (`src/domain-expiry.ts`). The watcher pass keeps the soonest expiry per host in KV `tls:expiry:v1`; both sets of dates are in the snapshot's `expiry` field, so `capsid_admin_read_ops` action `snapshot` shows them. A host it cannot read keeps its last date.

Each item is sent once (KV `push:state` keeps what was sent for 30 days), at most three items a tick, and an item no device received is tried again on the next tick. An alert names the repo or the namespace and its class and never carries a title or a button. Every alert opens its own item: a rollback opens the site's Deploys tab (`/sites/<namespace>?tab=deploys`), a site alert the site's page, the test alert the home page. A tap moves an open Portal tab to that page and opens a new one only when none is open; the service worker opens only a page on its own scope. The Worker encrypts each alert to the browser's own keys (RFC 8291) and signs the request with the VAPID key (RFC 8292) with WebCrypto only (site-runtime `./web-push`), so the push service sees neither the text nor a third-party account. A subscription whose endpoint is not on a known push service is refused before it is stored, and one the push service answers 404 or 410 for is marked `gone`. Audit rows: `push-device-on`, `push-device-off`, `push-test`, `push-sent` and `push-device-gone`.

To set it up: apply migrations (`npx wrangler d1 migrations apply capsid --remote`), run `node scripts/vapid-keys.mjs` (it puts `VAPID_PRIVATE_KEY` with wrangler and prints only the public half; running it again replaces the key and every device turns alerts on again), deploy, open Settings on the phone, press **Turn on for this device**, then **Send a test alert**. Until the key is set the panel says so. With no key, or no device on, the `push` step mails the same urgent items to `ALERT_EMAIL` instead (each once, audited `push-emailed`); with the digest's mail off too it sends nothing and says why.

## Daily digest

Everything not urgent enough for a phone alert waits for one email a day (`src/digest.ts`). Once a UTC day after 12:00 the tick's `digest` step mails `ALERT_EMAIL` the rollbacks since the last digest sent, and any device that stopped getting phone alerts in the last 14 days (named every day until a newer device with the same label is turned on). On Mondays UTC it also carries a **Weekly digest** section: the watcher's open digest-class findings per site (`src/watcher-digest.ts`). A send Cloudflare refuses is recorded for the day (KV `digest:last`) and shown in Settings, and the next day's digest covers both days.

It does nothing until Email Routing is on. Cloudflare sends from a Worker only from a domain with Email Routing turned on and only to a verified destination address, which is an account setting. The digest needs the `send_email` binding `EMAIL`, `ALERT_EMAIL`, `ALERT_FROM` and the var `EMAIL_ROUTING` set to `"on"`; until all four are set every tick returns at once and Settings, **Daily digest**, says which is missing. To turn it on:

1. In the Cloudflare dashboard open the dustinedwards.info zone, then Email, Email Routing. If the domain already receives mail through another provider (existing MX records), stop: turning it on would move that mail.
2. Press Get started (or Enable Email Routing), then Add records and enable.
3. On Destination addresses, add the address the digest should go to and press Verify email address in the verification email.
4. `wrangler.jsonc.example` carries the `send_email` binding `EMAIL` and the vars `ALERT_FROM` and `EMAIL_ROUTING: "on"`; set the verified address as the secret `ALERT_EMAIL` (`npx wrangler secret put ALERT_EMAIL --name capsid-mcp`) so it stays out of the public repo. The next deploy binds them.

Settings, Daily digest, then says **On**, and the first email arrives after 12:00 UTC.

## Using it

- **Where:** https://portal.dustinedwards.info, signed in through Cloudflare Access as `ADMIN_EMAIL` or a co-owner in `CO_OWNER_EMAILS`. **Sign out**, in the top bar, ends the Portal session in this browser. It works at phone width.
- **Keyboard:**
  - `Ctrl K` or `/` opens the command menu: any site, agent or view, and every stop (typing "stop" lists Revoke for each live agent, which opens the same confirm dialog as the agent drawer).
  - `g` then a letter goes to a page: `b` board, `h` health, `m` memory, `p` pull requests, `o` projects, `s` sites, `k` packages, `a` agents, `e` settings.
  - `j` and `k` move focus through a list's rows; Enter opens one. The detail panel is a modal dialog: Tab stays inside, Esc or a click beside it closes it, and focus returns to the row.
  - `f` goes to the page's text filter. A namespace filter lives in the address (`?ns=sample`); a list the filter empties says so, with "Show all".
  - `r` refreshes and `t` switches light and dark (Settings, Display has Capsomer's theme switch, localStorage `wf-theme`; until one is chosen the device's setting applies).
  - `[` collapses the side menu to its icons or expands it (localStorage `wf-rail`).
  - `?` lists the keys: Capsomer's shortcut sheet, built from the registry that runs them (`App.tsx`). Single-key shortcuts can be turned off in that sheet or in Settings, Display (localStorage `cap-single-keys`).
- **Width:** no view scrolls sideways from 1024 px up. Wide tables turn each row into a card when their panel is too narrow.
- **Freshness:** the top bar shows when the live part was read and when the watcher's pass ran. The stamp turns to the warning color when the pass is older than two cadences. The app polls every 60 seconds while its tab is visible.

## Building and changing it

`dashboard/` is its own package (React 19, React Router 8.5.1 in framework mode, TanStack Query) with its own lockfile and README. Every page is rendered on the server, so its content, text, tables and charts are in the HTML with scripts off:

- **Rendering:** the capsid Worker renders each page after the gate (`src/portal-app.ts`, `renderPortalPage`). `dashboard/src/worker.ts` and the server build are bundled into `dashboard/build/worker/portal.js`, which the Worker imports as `capsid-portal-pages` (the `alias` in `wrangler.jsonc.example`; tests use the stand-in `test/fixtures/portal-pages.ts`). Each route's loader prefetches its queries into a QueryClient made for that request (`dashboard/src/server/prefetch.ts`) through the Worker's own `/portal/api` routes with the visitor's cookies, and the page hydrates from them.
- **CSP:** each page carries its own nonce (`src/dashboard-csp.ts`, site-runtime's builder), given to React Router's scripts and the theme script; no `unsafe-inline`.
- **Develop:** `npm --prefix dashboard run dev` serves it with sample data (`dashboard/dev/sample-feed.json`, checked against `OpsFeed`).
- **Design tokens:** every color, font and shadow is a custom property from Capsomer (`capsomer` in `dashboard/package.json`, pinned to a release tag; `src/root.tsx` imports `capsomer/tokens.css`), whose own check refuses any text or control pair below WCAG 2.2's bar in either theme. Capsomer's rules sit in `cap.*` layers, so the Portal's unlayered styles win. Change a color in Capsomer, never here. The Portal is excluded from Cloudflare Web Analytics and its CSP names no analytics host.
- **Deploy:** `npm run build:dashboard` builds it before every deploy within its size budget: the browser's files into `dashboard/build/client`, which the Worker serves as static assets (the hashed `/assets/*` publicly on the Portal host, every other file behind the gate), and the pages into `dashboard/build/worker/portal.js`. A failed build stops the deploy.
- **Browser tests:** `npm run test:browser`, after `npm run build:dashboard`, drives the built app in Chromium through Playwright (`dashboard/e2e`) under `dashboard/dev/serve.ts`, which renders each page with the production build as the Worker does, the dev mock answering the reads, and the Worker's own page CSP. CI runs it after the build.
- **Size budget:** CI and every deploy run devkit's `devkit-size-budget` against `dashboard/.size-budget.json`, which fails closed: the heaviest page's JavaScript at most 215 KB gzip, each other chunk at most 40 KB, that page's CSS at most 47 KB, and the CSS loaded with later chunks at most 13 KB together.
- **Assets config:** the `assets` block in `wrangler.jsonc.example` must keep `run_worker_first: true` and `not_found_handling: "none"`; `test/dry-run-config.test.ts` fails if either changes. Without `run_worker_first`, Cloudflare serves any request that matches a file in the assets directory without running the Worker, so without the gate.

## Who gets in

The administrator's Access session, or a co-owner's, and nothing else (`src/portal-auth.ts`).

- **The sign-in.** The Portal signs in through the same Access for SaaS app and the same `ADMIN_EMAIL` or `CO_OWNER_EMAILS` check as the MCP flow ([auth.md](auth.md)), with its own callback at `/portal/callback`, and turns the verified email into a signed cookie, `capsid_portal`, that lasts 24 hours. An hour with no request ends it: site-runtime's `adminIdle` times the session (`withPortalIdle` in `src/portal-auth.ts`, its last-request cookie `__Host-admin-seen`), and the browser is sent to Access's logout. The check runs again on every request. Each sign-in, refused sign-in, sign-out and idle end is one auth event line in the Worker's log (site-runtime `./log`, the address as a digest).
- **Co-owner.** Admitted exactly like the administrator: her email in the optional secret `CO_OWNER_EMAILS` (comma separated; entries trimmed and lower-cased), checked on the sign-in and every request. Her clicks are recorded as `access:<her email>`. She cannot change who is admitted: `ADMIN_EMAIL` and `CO_OWNER_EMAILS` are set only in Cloudflare (Workers & Pages, capsid, Settings, Variables and Secrets, as a Secret, not Text), so she cannot remove or demote the primary owner from inside Capsid. The Access policies that admit the admin must list her email too. The push alerts' VAPID subject stays `ADMIN_EMAIL`.
- **Cookies.** `capsid_portal`, `capsid_portal_csrf` and the sign-in's `capsid_portal_state` are all `HttpOnly; Secure; SameSite=Lax` and host-only: none ever carries a `Domain` attribute, so no other subdomain of dustinedwards.info can read or set them. On portal.dustinedwards.info they are `Path=/` and named `__Host-`; on workers.dev they are `Path=/portal` and named `__Secure-` (`cookieName` in `src/auth.ts`), so `/mcp` and `/ops` there never see them. `test/portal-login.test.ts` fails if any gains a `Domain` or leaves its host's path. The sign-in returns only to a Portal path.
- **Sign out** (`POST /portal/api/sign-out`) expires the cookies in this browser, passes the same checks as an action (so another site cannot sign the administrator out), and ends the session on the server: the cookie's session id is written to D1 (`portal_session_ends`) and a cookie carrying it is refused, so a copy taken from this browser ends too, while sessions in other browsers go on. The idle end does the same. The Access session at the team domain is Cloudflare's, so the next visit may sign in again without asking for the email.
- **Machines.** An agent key gets a 403 that says so. Keys authenticate to `/ops/mcp`, which serves the same state through `capsid_read_status` action `status`.
- **It never merges and it never mints.** Merging can start a CI deploy, so that stays with `capsid_close_pr` action `merge` behind `can_merge`. Minting hands out a key, so that stays with `capsid_admin_manage_agents`. Neither is in the Portal's action list, and a test asserts their absence.
- **Each click names where it came from.** A click's audit row (`portal-<action>`) and a Refresh's `portal-ops-refresh` row carry `source_address`: Cloudflare's `CF-Connecting-IP`, which a client cannot set. A value that is not an IPv4 or IPv6 address is recorded as null. The Activity drawer shows it as Source address.

## Routes

Every route but the callback answers to one gate, `portalGate`: the Access session and the admin check on every request, a 403 for any `Authorization` header, and the sign-in for no session. The router matches the callback and every `/portal/api/` route before the app's catch-all.

- **`GET /portal/api/ops`** returns `OpsFeed`, uncached: the watcher's last pass from KV, plus the agents, the inbox and `live.findings`. It also carries the `csrf` value the controls send back, and `user` (name and initials) for the avatar: the `name` claim of the Access ID token, else the local part of the email, read from the signed session cookie (`portalDisplay` in `src/portal-auth.ts`). One request costs 13 D1 statements plus one per scheduled task and 6 KV reads, run concurrently; `src/ops-feed.ts` states them and an integration test counts them.
- **`POST /portal/api/ops/refresh`** runs one watcher pass now and returns the new feed. It needs the header `X-Capsid-Ops: refresh`, which a cross-site form cannot send, and runs at most once per two minutes (KV `ops:refresh:last`; a 429 with `Retry-After` inside that window, and a 503 when the stamp cannot be read or written). Audited as `portal-ops-refresh` under `access:<email>`.
- **`POST /portal/api/actions/preview`** and **`POST /portal/api/actions/perform`** are the controls' two doors (`src/portal-actions.ts`; the registry is `src/controls.ts`; `capsid_admin_run_controls` is the other door, with the same preview and perform and its own `control-<action>` audit rows). The confirm is a second request:
  - The preview takes `{action, params}`, reads the current state, writes nothing, and returns what will change, the audit rows the perform will write, and a signed token good for five minutes that carries the action, its params, the admin's email and a one-time id.
  - The perform takes only `{token}`, so what runs is exactly what the dialog showed.
  - A token is used once: the perform spends its id in KV (`control-nonce:<id>`) before the control runs, so a second perform is refused with 409 and writes nothing, even when the control then refuses; preview again. KV has no compare-and-set, so the guard on the state each transition moves from is what stops two performs in the same instant.
  - Both refuse a `Sec-Fetch-Site` that is present and not `same-origin`, and need the header `X-Capsid-CSRF` to equal the cookie `capsid_portal_csrf`; the feed body carries that value, and a cross-site page cannot read it.
  - Refusals: 400 refused, 403 CSRF or cross-site, 409 already used, 410 expired, 413 too large.
  - A perform writes the shared mutator's audit row, then `portal-<action>` under `access:<email>` with `surface: "portal"` in its params (`control-<action>` and `"chat"` from the tool). Rows from before the move say `console-<action>` ([schema.md](schema.md)).
- **`GET /portal/api/namespaces`** returns each roster namespace as `capsid_read_status` action `status` reports it. **`GET /portal/api/activity?namespace=&actor=`** returns the last 50 audit rows, filtered, each with its named detail; **`?id=`** returns that one row, and an id that is not a positive whole number is refused with 400.
- **A site's page** reads four routes (`src/portal-site.ts`), uncached, each for one namespace and each a door onto a reader the chat tools already serve. The site, its Search Console property, its Bing site and its Worker come from the namespace's `ops_sites` row, never the request. Each source in an answer is `SiteSource`: `{ ok: true, data }`, or `{ ok: false, kind, reason }` with `kind` one of `no_site`, `not_configured` (the secret or token the read needs is unset), `empty` (the read worked and found nothing) and `error`, so one source failing leaves the others. A namespace that is not a slug is a text 400. Types: `src/ops-types/views.ts`. Tests: `test-integration/portal-site.test.ts`.
  - **`GET /portal/api/site-search?namespace=`** returns `PortalSiteSearch`: `google`, Search Console's totals, top queries and top pages over the 28 days ending 3 days ago, and `bing`, Bing Webmaster's daily traffic, top queries and top pages over the same window.
  - **`GET /portal/api/site-traffic?namespace=&days=`** returns `PortalSiteTraffic`: the `not_found`, `server_errors`, `web_vitals` and `ai_crawlers` reports over the last `days` (1 to 30, default 7; any other is a text 400). Zero 404s or 5xx is a real answer; web vitals with no measured page view is `empty`; a `workers.dev` host is `not_configured`.
  - **`GET /portal/api/workers-builds?namespace=&limit=`** returns `PortalWorkersBuilds`: the Workers Builds of the site row's script, newest first (`limit` 1 to 50, default 10). A Worker deployed from CI with wrangler has no builds, which is `empty`.
  - **`GET /portal/api/build-log?build=<uuid>`** returns `PortalBuildLog`: one build's last 500 lines. An id that is not a lowercase UUID is a text 400.
- **`GET /portal/api/convergence`** (`src/portal-convergence.ts`) returns `PortalConvergence`, uncached: each opted-in site's `sync_status` and health checks read live, the repair each check maps to, the watcher's last read of its Worker's secret names, and its last five repairs.
- **`GET /portal/api/maintenance`** (`src/portal-maintenance.ts`) returns `PortalMaintenance` from KV only: the list the daily maintenance pass stored, with `generated` null before the first pass, and `read`, what the pass read.
- **`GET /portal/api/push`** and **`POST /portal/api/push`** (`src/push.ts`): the GET returns `PortalPush` (the VAPID public key, null with the reason when unset; the devices with alerts on, never an endpoint; and the daily digest's state). The POST takes `{op: "on", subscription, label}`, `{op: "off", id}` or `{op: "test"}` behind the preview's checks (same-origin, the body cap, CSRF). Refusals: 400 a bad subscription or op, 409 a device already off or ten already on, 503 no key.
- **`POST /portal/api/sign-out`**, above. Any other `/portal/api/` path is a JSON 404 behind the gate, never the app's page.
- **`/portal/`** and everything under it serves the built app from the `ASSETS` binding only after the gate. The page gets `no-store` and its own CSP (scripts, styles and fetches from this origin only); hashed files under `/portal/assets/` are cached privately for a year. A browser loading an unknown path as a page gets the app's page; a missing file stays a 404. With no `ASSETS` binding the admin gets a 503 saying the Portal is not deployed.
- **The live check.** `scripts/verify-live.mjs` gate 6 asserts `/portal/` answers an anonymous caller with the sign-in (302) and `/console`, `/console/app/` and `/console/callback` each answer 404. Gate 7 asserts that https://portal.dustinedwards.info/ and its `/mcp` answer an anonymous caller with a 302 to the Access team domain. It reads `PORTAL_ORIGIN` when set.

### What needs Dustin, per app

`GET /ops/inbox` (`src/inbox.ts`) answers, for each configured app (the `ops_sites` rows, plus any namespace with something waiting), a count, a severity (needs-you, failing or none) and the items behind it: a failing CI run, a site that is down, and what the app reported about itself. It is read by each app's server with a key, not a browser: a key scoped to one namespace sees that app alone, the admin sees every app, and the response carries no CORS headers and is cached for 30 seconds privately. `capsid_read_status` action `status` carries the same answer per namespace as `needs_dustin`.

What only the app knows (Carrel's drafts waiting) it reports itself: `POST /ops/inbox/report` (`src/inbox-report.ts`) with its own key, which must hold the write grant on the namespace the body names. The body is `{ "namespace": "...", "items": [{ "title", "link"?, "since"? }] }`: at most 20 items, titles up to 200 characters, a link only on the app's own `ops_sites` origin, no severity field (a reported item always counts as needs-you, so an app cannot quiet its own badge). Each report replaces the last whole and expires after 6 hours, so an app that stops reporting stops being counted; send `items: []` to clear. One report per minute per key, refused with 429, and 503 when the counter cannot be read. The inbox lists the items as kind `report`, and `capsid_read_status` relays each title inside an external fence (`src/provenance.ts`), since an agent reads it. Tests: `test/inbox.test.ts`, `test-integration/inbox.test.ts`.
