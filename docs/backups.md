# Backups and restore

D1 Time Travel already provides 30-day point-in-time recovery, so backups here are for longer retention and portability.

A daily Cron Trigger (09:00 UTC) exports the database to `MEDIA`:

- `backups/json/<timestamp>/<table>.json` one JSON dump per table, plus `_schema.json`, the CREATE statements `sqlite_master` held. The dump is [`@dustinedwards/d1-dump`](https://github.com/DrDustinEdwards/d1-dump)'s `runCheckedBackup`, the nightly job each site runs, so Capsid and the sites run one implementation: its standard checks and its credential-column check (`credentials`, with `CREDENTIAL_ALLOW` naming the columns that hold token counts) run beside Capsid's own (`tables-mismatch`, the preflight, the lease). It dumps every table `sqlite_master` lists, skipping `documents_fts` and its shadow tables. Capsid excludes `d1_migrations`, wrangler's migration ledger, and `push_subscriptions`, whose rows carry each device's push keys (area 8, B8): a restore has that table empty, and each device turns phone alerts on again in the Portal. `TABLES` in `src/backup.ts` is the list the migrations create. A run whose dumped tables differ from it is refused as `tables-mismatch` and keeps its dumps unmarked, because the restore below knows only the migrations' schema. Retention is d1-dump's graduated default (`pruneDumps`, capsid/rulings/shared-homes-2026-10-06.md): the newest complete run of each of the last 14 days, 8 ISO weeks and 6 calendar months is kept, about 25 runs reaching back six months, and any other run is deleted whole. The newest complete run is never pruned, and nothing is pruned while no run is complete. A run is complete when it carries `_complete.json`, which is written last and only when the preflight passed; a run that threw mid-export or was refused has none, holds no slot, and is kept only while it is inside the 14-day window. A run with no marker counts as incomplete whatever its age: the carve-out for runs written before the marker existed (2026-09-25) is gone. `test/backup.test.ts` holds the wiring; the policy is tested in d1-dump.
- `backups/markdown/<namespace>/<path>` a plain-markdown mirror of every document body, one file per document, tracking current state (files for deleted documents are pruned).

Every put to `MEDIA` in a run is tried up to three times, a second and then two apart (`retryingPuts`, `src/backup.ts`): R2 now and then refuses one with "We encountered an internal error. Please try again. (10001)", and before this one refusal threw the whole run away (the runs of 2026-10-27 and 2026-10-30 did, and `/health` reported the backup 38 hours old). The multipart parts d1-dump streams for the paged tables are not retried; a failed part still fails the run.

After each export, `document_versions` rows older than 90 days and `audit_log` rows older than 180 are pruned. Pruning runs after the export, so every pruned row exists in at least one retained dump.

The private `DrDustinEdwards/capsid-backups` repository mirrors the JSON dumps off-account, so they survive loss of the whole Cloudflare account. Its workflow, schedule and retention live in that repository; this repo mints its credential at `POST /backup/credential` and observes the result. The request may name a `site`; the Worker scopes the credential to that site's bucket from the pinned table in `src/offaccount.ts` and refuses any other site with 400. A request with no site is capsid's (`capsid-media`).

**The watcher measures the mirror, and it measures the dump rather than the run.** Every half hour it lists `backups/json/` in that repo, resolved through the capsid namespace's `backups` mapping, and reads the newest directory name as the dump's own timestamp. Older than `MIRROR_STALE_HOURS` (36, the daily cadence plus slack) and it posts a finding, using the mirror workflow's latest conclusion to say which of three things happened: the workflow ran and failed, it has not run at all, or it ran green and no dump appeared. A GitHub it cannot reach posts nothing, because "cannot see the mirror" and "the mirror is dead" are different facts.

The dump is the signal because the attempt is not. The mirror was dead from 2026-09-09 to 2026-09-12, and on every one of those days it requested and received a valid backup credential before failing two steps later, so anything keyed on the credential reported it healthy. `MIRROR_STALE_HOURS` is deliberately not `BACKUP_STALE_HOURS`: that one is the local dump at 26 hours measured from a key this Worker writes, and the other repo's schedule can change without this one hearing.

Run one on demand with the admin credential, a write-grant `OPERATOR_KEY_HASH` key. A backup and its prune cover every namespace, so a minted agent is refused with 403 even when it holds write, and a missing or unknown key gets 401:

```
curl -X POST https://capsid.<your-subdomain>.workers.dev/ops/backup -H "Authorization: Bearer <key>"
```

The status says what happened without the body: 200 for a clean run, 409 when another run holds the lease and this one did nothing, and 503 when the preflight refused the prune (the dumps are written, but nothing is marked, mirrored or pruned; `prune_refused` names the reason).

## Bucket locks on the dumps

Each bucket that holds d1-dump runs gets one R2 bucket lock rule on `backups/json/` with a 13 day age, so no delete or overwrite (a buggy prune, a leaked R2 token, a Worker gone wrong) can remove a dump in its first 13 days. Older dumps are protected by the off-account mirror, not by the lock. Nothing else in a bucket is locked: in `capsid-media` the rule never covers `backups/markdown/` (the mirror rewrites and prunes it every night) or media, and in `txasm-books` it never covers the generated books.

### What R2 does

Facts from Cloudflare's documentation, read from its source (cloudflare/cloudflare-docs, commit 0d35c2c, 2026-10-11) because the docs site was not reachable from the session that wrote this:

- A lock rule prevents the deletion and overwriting of objects for a period or indefinitely. A rule has an id, `enabled`, an optional `prefix` (no prefix means every object in the bucket) and a `condition` that is one of `Age` with `maxAgeSeconds`, `Date` (retain until a date), or `Indefinite`. A bucket takes up to 1,000 rules; where several cover one object, the longest retention wins. Rules apply to existing objects as well as new ones. Source: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- A refused delete is an error, not a silent no-op: R2 error 10069, `ObjectLockedByBucketPolicy`, HTTP 403, "Object is protected by a bucket lock rule and cannot be modified or deleted." Source: https://developers.cloudflare.com/r2/api/error-codes/ . The Workers binding's `delete` takes up to 1000 keys per call and resolves only once the delete succeeds (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), so a refusal throws out of the call. The docs do not say whether the other keys in a refused bulk call are deleted.
- Rules are set three ways: the dashboard (R2 object storage, the bucket, Settings, Bucket lock rules), Wrangler (`wrangler r2 bucket lock add`, `remove`, `list`, and `set` from a JSON file, which replaces every rule), and the API (`PUT /accounts/<account>/r2/buckets/<bucket>/lock` with the whole rule list; a rule is removed by leaving it out). Sources: https://developers.cloudflare.com/r2/buckets/bucket-locks/ , https://developers.cloudflare.com/workers/wrangler/commands/r2/#r2-bucket-lock-add , https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/methods/update/
- `wrangler r2 bucket lock add <bucket> --name <rule> --prefix <prefix>` takes exactly one of `--retention-days <n>` (stored as an `Age` condition of n times 86,400 seconds), `--retention-date <YYYY-MM-DD>` or `--retention-indefinite`. `--name` has the alias `--id`. With all three given it asks nothing. `wrangler r2 bucket lock remove <bucket> --name <rule>` reads the rules, drops that one and writes the rest back. Checked in Wrangler's own source, `src/r2/lock.ts` in the 4.107.0 this repo pins, against https://developers.cloudflare.com/workers/wrangler/commands/r2/#r2-bucket-lock-add
- Lock rules outrank lifecycle rules, and a bucket cannot be emptied while any lock rule is configured: remove the rules first. Sources: https://developers.cloudflare.com/r2/buckets/bucket-locks/ , https://developers.cloudflare.com/r2/buckets/delete-buckets/
- Nothing in the docs makes a rule irremovable. A token that can edit the bucket's configuration can remove the rule and then delete, so the lock guards against object-level access (a Worker's R2 binding, an R2 object token), not against the account.

### What pruneDumps does with a refusal

Before d1-dump v0.4.2, `pruneDumps` listed the runs, picked the stale ones with `selectStaleRuns`, and passed every key of every stale run to one `deleteInChunks` call, 1000 keys a call. Nothing caught an error. One refused key therefore threw out of `pruneDumps`: no stale run after that chunk was deleted, and the throw reached the caller's nightly run. In Capsid that is `pruneR2` inside `exportAndPrune` (`src/backup.ts`): the marker and the markdown mirror are already written, but the CSP report prune, the `document_versions` and `audit_log` prune and the `backup:last-ok` stamp are skipped, so the run reports an error and `/health` warns once the stamp is 26 hours old. The same young run is stale again the next night, so the failure repeats every night until that run is older than the lock. A site still on v0.4.1 or earlier behaves this way.

v0.4.2 (d1-dump pull request #17, the tag Capsid pins in `package.json`; its README, "Bucket locks") fixes it: each stale run is deleted on its own, `_complete.json` first and then the rest, so a partly deleted run never looks complete. A refusal with error 10069 skips that run, counts it in the result's `locked` field (`kept + pruned + locked` is every run), and the prune goes on to the other runs. Any other delete failure still throws. A later prune selects the skipped run again and deletes it once the lock has aged off it. Capsid reports the count as `json_backups_locked` in its backup summary.

### Why 13 days

`pruneDumps`'s default policy (capsid/rulings/shared-homes-2026-10-06.md) keeps the newest complete run of each of the last 14 UTC days, counting today, so a run made on day D is inside the daily window for prunes on days D through D+13. These are every delete it can make, by age:

- A second complete run on one UTC day (a manual `/ops/backup` after the cron, a retried run) makes the older run of that day stale at the next prune, minutes or hours after it was written. No lock age above zero allows this delete, so the lock refuses it. This is the one delete the lock refuses in normal operation, and it is why the d1-dump fix must come first.
- An incomplete run holds no slot and is kept while its day is in the daily window, so it is deleted at the first prune on day D+14 or later.
- A complete run that is the newest of its day is kept while its day is in the daily window. It leaves the window at the same boundary and is then kept or deleted by the weekly and monthly slots, so its delete, if any, comes on day D+14 or later.
- The newest complete run is never deleted.

So apart from same-day duplicates, the youngest object `pruneDumps` deletes was written on day D and is deleted no earlier than 00:00 UTC on day D+14. A run id is at most 23:59:59 on day D, so that object is more than 13 days old. 13 days is the longest whole-day lock that never refuses those deletes. A 14 day lock would not: the cron writes a run at about 09:00 UTC and the prune fourteen days later runs at about 09:00 too, so the two are minutes apart and the outcome would depend on how long each night's dump took. With the cron at 09:00 the real margin under a 13 day lock is about a day. The only way to get closer is a run started just before midnight and a prune just after midnight fourteen days on, where the run's later objects can be a few minutes short of 13 days; with the fix that run is skipped one night and deleted the next.

A site that passes its own policy agrees with 13 days while its `daily` is at least 14; a site on the flat rule agrees while its `retentionDays` is at least 14 (the default is 90). Capsid passes only `prefix` and `now`, so it runs the default. The sites' calls are not visible from this repository: before locking a site's bucket, check that its `pruneDumps` call passes no `policy` with `daily` under 14 and no `retentionDays` under 14.

What a refused delete costs, once the fix is in: one run's objects stay up to 13 days longer than retention wanted, and that night's result reports `locked` above zero. A same-day duplicate is deleted at the first prune after it is 13 days old. Without the fix it costs a failed nightly run every night for up to 13 days, with every other stale run kept meanwhile.

### Order

1. d1-dump v0.4.2 carries the fix (released; Capsid pins it and reports `json_backups_locked`).
2. Bump every other site that calls `pruneDumps` to v0.4.2 or later and deploy it. Check each site's pinned tag first: this repository cannot see it.
3. Only then add the lock to that site's bucket. A bucket locked while its site still runs v0.4.1 or earlier fails its nightly run on any day a same-day duplicate is pruned.

Safe to lock first, before any bump: `dustinedwards-backups`, because the dustinedwards site runs no d1-dump today (`src/offaccount.ts`), so nothing prunes there (if its d1-dump job, job_e40ec706c10a, lands first, it must pin the fixed release before this lock); and `carrel-backups` if Carrel's Worker does not call `pruneDumps` (check before locking it). The other five wait for their site's bump.

### Steps, one bucket at a time

Run each from a machine where `npx wrangler login` is signed in to the account that owns the buckets. Do one bucket, run its verify, and let one nightly run pass on that site (its backup result with `locked` at 0 or a small number, and no error) before the next. If a bucket was created with a jurisdiction, add `--jurisdiction <name>` to each command for it.

The rule name is `backups-json-13d` on every bucket. `wrangler r2 bucket lock add` appends a rule, so running it twice on one bucket adds a duplicate; list first.

1. `dustinedwards-backups`
   - Add: `npx wrangler r2 bucket lock add dustinedwards-backups --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list dustinedwards-backups` shows `backups-json-13d`, prefix `backups/json/`, 13 days, enabled.
   - Undo: `npx wrangler r2 bucket lock remove dustinedwards-backups --name backups-json-13d`
2. `carrel-backups` (first only if Carrel runs no `pruneDumps`; otherwise after its bump)
   - Add: `npx wrangler r2 bucket lock add carrel-backups --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list carrel-backups`
   - Undo: `npx wrangler r2 bucket lock remove carrel-backups --name backups-json-13d`
3. `capsid-media` (after Capsid runs the fixed d1-dump). The prefix keeps `backups/markdown/` and media unlocked.
   - Add: `npx wrangler r2 bucket lock add capsid-media --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list capsid-media`, then the next nightly backup finishes without error.
   - Undo: `npx wrangler r2 bucket lock remove capsid-media --name backups-json-13d`
4. `germomics-backups` (after Germomics runs the fixed d1-dump)
   - Add: `npx wrangler r2 bucket lock add germomics-backups --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list germomics-backups`
   - Undo: `npx wrangler r2 bucket lock remove germomics-backups --name backups-json-13d`
5. `txasm-books` (after txasm runs the fixed d1-dump). The prefix keeps the generated books unlocked.
   - Add: `npx wrangler r2 bucket lock add txasm-books --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list txasm-books`
   - Undo: `npx wrangler r2 bucket lock remove txasm-books --name backups-json-13d`
6. `foxing-backups` (after Foxing runs the fixed d1-dump)
   - Add: `npx wrangler r2 bucket lock add foxing-backups --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list foxing-backups`
   - Undo: `npx wrangler r2 bucket lock remove foxing-backups --name backups-json-13d`
7. `foxhound-backups` (after Foxhound runs the fixed d1-dump)
   - Add: `npx wrangler r2 bucket lock add foxhound-backups --name backups-json-13d --prefix backups/json/ --retention-days 13`
   - Verify: `npx wrangler r2 bucket lock list foxhound-backups`
   - Undo: `npx wrangler r2 bucket lock remove foxhound-backups --name backups-json-13d`

Do not test a lock by writing a probe object under `backups/json/`: `pruneDumps` reads any folder there as a run, finds it stale, and tries to delete it every night for 13 days. The list output and a clean nightly run are the check.

## Restore

Three paths, in the order to try them. Path 2 has been executed end to end against a scratch database: all table counts matched the source and search worked on the restored copy. `restore-rehearsal.yml` runs d1-dump's restore drill on the newest R2 dump every Monday (see "The weekly drill" below).

1. **D1 Time Travel** (last 30 days, fastest), for fat-finger recovery or a bad bulk change. Run `wrangler d1 time-travel info capsid`, then `wrangler d1 time-travel restore capsid --bookmark=<bookmark>`. This rewinds the live database in place, so take a fresh bookmark first to keep the restore reversible.

2. **Table-scoped export and import**, for rebuilding into a new database. `wrangler d1 export` fails outright here, because D1 cannot export databases with FTS5 virtual tables. Export the real tables individually and data-only, taking the schema from the migrations:

   ```
   wrangler d1 export capsid --remote --no-schema --table <table> --output export-<table>.sql
   ```

   There are thirty-four dumped tables, and one more real table never dumped: `documents`, `namespaces`, `document_versions`, `audit_log`, `document_links`, `jobs`, the work queue (`migrations/0006_jobs.sql`), `job_outcomes`, what each finished job produced (`migrations/0011_job_outcomes.sql`), `agents`, the scoped credentials (`migrations/0008_agents.sql`), `improve_jti`, the signed-request replay cache (`migrations/0004_improve_jti.sql`), `job_outcome_prs`, which pull requests an outcome counted (`migrations/0015_outcome_prs.sql`), `ops_sites`, the sites Capsid Portal watches (`migrations/0022_ops_sites.sql`), `ops_packages` and `ops_package_weeks`, the packages it watches and their weekly GitHub numbers (`migrations/0028_ops_packages.sql`), and `job_claims`, `job_evaluations` and `job_touches`, the claims dataset: what each agent said it did, each check of that against GitHub, and every human touch of a job (`migrations/0023_job_claims.sql`), `watcher_findings`, the watcher's memory of each finding across jobs (`migrations/0024_watcher_findings.sql`), and `agent_sessions`, `session_events` and `session_usage`, what Claude Code sessions reported by hook and telemetry (`migrations/0025_agent_sessions.sql`), and `task_runs`, the run ledger of every scheduled task (`migrations/0029_task_runs.sql`), and `job_versions`, the versions of a job that an edit replaced (`migrations/0033_job_versions.sql`), and `canon_proposals`, drivers' proposed changes to canon documents and who decided them (`migrations/0034_canon_proposals.sql`), and `shared_packages`, the shared packages the Portal's Shared code view follows (`migrations/0036_shared_packages.sql`), and `pr_approvals`, the merge pipeline's approval record: who approved which pull request at which head, and how each approval ended (`migrations/0037_pr_approvals.sql`), and `agents_archive`, revoked agents the watcher pass moved out of `agents` (`migrations/0038_agents_archive.sql`), and `deploy_outcomes`, what became of each deploy whose live gate ran (`migrations/0039_deploy_outcomes.sql`), and `access_sync_groups`, the Access group pinned for each app's members page (`migrations/0040_access_sync_groups.sql`), and `push_subscriptions`, the devices that get a phone alert (`migrations/0041_push_subscriptions.sql`; never dumped, so it restores empty), and `bench_tasks` and `bench_runs`, the methods paper's paired comparison: the registered tasks and every run's outcome (`migrations/0047_bench.sql`), and `bench_registration` and `bench_draw`, its registration hashes and the drawn task order (`migrations/0049_bench_draw.sql`), and `page_404_daily`, Capsid's own 404 counts by path and day, kept 90 days (`migrations/0053_page_404_daily.sql`), and `ops_uptime_daily`, each watched site's probes and how many found it up, by day, kept 90 days (`migrations/0054_ops_uptime_daily.sql`). The improve loop's and the stored skills' tables (all but `improve_jti`) were dropped by `migrations/0048_drop_improve_loop.sql` on 2026-10-19; dumps from before then still carry them. `TABLES` in `src/backup.ts` is authoritative, derived-checked against `migrations/` by `test/backup.test.ts`. Never export `documents_fts` or its `documents_fts_*` shadow tables: FTS5 derives them from `documents`, and they are what makes a whole-database export fail.

   Create the new database and apply every migration in order: `0001_init.sql`, `0002_document_links.sql`, `0003_improve.sql`, `0004_improve_jti.sql`, `0005_query_plan_indexes.sql`, `0006_jobs.sql`, `0007_jobs_resume.sql`, `0008_agents.sql`, `0009_jobs_required_scopes.sql`, `0010_console_indexes.sql`, `0011_job_outcomes.sql`, `0012_skill_records.sql`, `0013_skill_attribution.sql`, `0014_skill_status_index.sql`, `0015_outcome_prs.sql`, `0016_jobs_retry_cap.sql`, `0017_jobs_review.sql`, `0018_improve_unjudged.sql`, `0019_jobs_blocked_is_open.sql`, `0020_jobs_superseded.sql`, `0021_agents_job_binding.sql`, `0022_ops_sites.sql`, `0023_job_claims.sql`, `0024_watcher_findings.sql`, `0025_agent_sessions.sql`, `0026_outcome_pr_identity.sql`, `0027_job_summary_signature.sql`, `0028_ops_packages.sql`, `0029_task_runs.sql`, `0030_close_finished_job_mirrors.sql`, `0031_job_touches_admin_complete.sql`, `0032_job_model_routing.sql`, `0033_job_versions.sql`, `0034_canon_proposals.sql`, `0035_ops_sites_operator.sql`, `0036_shared_packages.sql`, `0037_pr_approvals.sql`, `0038_agents_archive.sql`, `0039_deploy_outcomes.sql`, `0040_access_sync_groups.sql`, `0041_push_subscriptions.sql`, `0042_jobs_started.sql`, `0043_pr_approvals_unit.sql`, `0044_jobs_no_leases.sql`, `0045_no_runner_keys.sql`, `0046_documents_updated_index.sql`, `0047_bench.sql`, `0048_drop_improve_loop.sql`, `0049_bench_draw.sql`, `0050_bench_run_keys.sql`, `0051_ops_sites_health.sql`, `0052_ops_sites_hosts.sql`, `0053_page_404_daily.sql`, `0054_ops_uptime_daily.sql`. Stopping early leaves later tables missing for the import to land in, and a column the code reads absent from a table that does exist. Then empty `ops_sites` and `shared_packages` with `DELETE FROM ops_sites` and `DELETE FROM shared_packages`: `0022_ops_sites.sql` and `0036_shared_packages.sql` seed them (and `0035_ops_sites_operator.sql` sets one row's operator, `0051_ops_sites_health.sql` sets health routes and adds Carrel's row, and `0052_ops_sites_hosts.sql` adds the further hosts), and the dump is each table's whole content, so a seeded row left in place would bring back a row removed since or collide with the dumped row on its key. The drill needs no such delete: it builds its scratch database from `_schema.json`, which holds no seed rows. The three claims tables are append-only, enforced by triggers that abort any UPDATE or DELETE of a row, and `bench_runs` refuses any DELETE. They still restore, in the drill as here (it creates triggers after the rows): each is empty when the restore deletes from it, and a DELETE that matches no row fires no trigger. Then execute the exports with `documents` first: importing it fires the FTS sync triggers, so `documents_fts` rebuilds itself. The rest have no insert triggers and no foreign keys, so their order does not matter. Verify with count queries against both databases and one MATCH query on the new one, then point `wrangler.jsonc` at the new `database_id` and deploy.

3. **The R2 JSON dump**, beyond the 30-day Time Travel window. Wrangler cannot list R2 objects, so take the exact keys from the Cloudflare dashboard or the `json_keys` field of a `/ops/backup` response, then fetch each: `wrangler r2 object get capsid-media/backups/json/<timestamp>/<table>.json --file <table>.json`. Convert each object's `rows` to INSERT statements and follow path 2 from the create step, `documents` first. The same dumps are mirrored off-account in `capsid-backups`, so this path works if the Cloudflare account is gone. The `backups/markdown/` mirror is the last-resort human-readable copy: bodies only, no metadata.

   `_schema.json` rides beside the tables too. This manual restore takes the schema from the migrations and does not need it; the drill builds its scratch database from it. One more underscore-prefixed sidecar rides beside the tables and is not D1:

   - `_kv.json` holds the KV pins, by allowlist: one key, `backup:last-ok`. Older dumps carry more keys, which nothing reads now. Put it back with `wrangler kv key put`. A `null` value means the key was unset; `{"unreadable": "<reason>"}` means the run could not read it, so the dump does not know its value and it must not be restored as unset. This is not a prefix sweep of `APP_KV`: that namespace also holds cached GitHub installation tokens, and a dump leaves the account.
   - Older dumps also carry `_holdout-manifests.json`, which nothing reads; a restore skips it.

   The dump is read in a single D1 batch, so its tables describe one instant. `document_versions` and `audit_log` are the exceptions in how they are read, not in what they hold: the batch reads each one's `MAX(id)`, and the rows up to that id are then paged and streamed to R2 as a multipart upload, because reading `document_versions` whole exceeded the isolate's memory from 2026-09-20. Both tables are append-only with an AUTOINCREMENT id, so the bound still describes the batch's instant. `documents` and `jobs` are updated in place, so they are still read whole inside the batch. Each file has the same shape as every other table's. `scripts/dump-invariants.ts` checks the dump weekly and refuses a torn one.

## The weekly drill

`restore-rehearsal.yml` runs every Monday 11:30 UTC and on demand (`gh workflow run restore-rehearsal.yml`). It pulls the newest complete run (the newest prefix that carries `_complete.json`; a refused run keeps its unmarked JSON as evidence and is skipped, as `latestDump` skips it) from R2 with the minted object-read-only credential, then:

1. `node scripts/dump-invariants.ts` reads the run directory and fails when `_complete.json` does not list exactly the files present, the `_kv.json` sidecar is missing or empty, an underscore-prefixed file it does not know rides along (`_schema.json` and an older dump's `_holdout-manifests.json` are allowed), a table file's `table` field is not its file name, a row lost a column its siblings carry, `documents` is empty, or the dump is torn (a version row for a document created after the documents read, or a `write` audit row at or after the newest document naming a path not in the dump).
2. `npx d1-dump drill` (the restore drill in [d1-dump](https://github.com/DrDustinEdwards/d1-dump), the version `package.json` pins) restores the run into a scratch SQLite file (`--backend sqlite`, Node's built-in `node:sqlite`) named `restore-drill-<date>-<pid>`, then fails when the run is older than 26 hours, a table's rows differ from the marker, an external FTS5 index (`documents_fts`) holds a different number of documents than `documents` (counted through `_docsize`), a search for a word from a restored row finds nothing, any statement is over D1's 100,000 byte cap, a table's rows do not carry exactly the columns `_schema.json` gives it, or the scratch file could not be deleted. It deletes the scratch file whatever happened.

The drill replaces `scripts/restore-rehearsal.mjs`. Like it, the drill holds no Cloudflare credential: it restores into a local SQLite file, and the workflow sets no Cloudflare secret. That is a ruling (Dustin, 2026-10-05): a D1 Edit token covers every database in the account and cannot be limited to scratch databases, so a compromised action or a later workflow edit could delete production. What the sqlite backend cannot prove (D1's remote bound-value cap, its request limits, any difference between D1's SQLite build and Node's) is listed in d1-dump's README; capsid's values are bound, never literals, and every row in a dump was accepted by D1 when written. The same drill against a real D1 database is run by hand from the seat's machine, quarterly and after a change to the restore: `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npx d1-dump drill --dir <downloaded run> --backend d1`. A d1 drill killed before its cleanup leaves a database named `restore-drill-*`: list with `npx wrangler d1 list` and delete with `npx wrangler d1 delete <name>`.

## Drill every site

One command proves every site's backups from Dustin's machine, with his own wrangler login and no token in env, arguments or output:

```
npx wrangler login
node scripts/drill-all.ts            # every site
node scripts/drill-all.ts --site carrel --site foxhound
```

Run it after 04:00 UTC on a night both the foxhound and carrel crons have run, so each bucket holds a fresh run and the 26 hour check can pass (the script checks the age itself and runs the drill with `--max-age-hours off`, so the printed age and the verdict read one clock). `wrangler r2 object` cannot list, so the script opens each site's bucket (`SITES` in `scripts/drill-all.ts`: foxhound, carrel, germomics) through wrangler's `getPlatformProxy` with a remote R2 binding, finds the newest run that carries `_complete.json`, downloads it to a temp directory, runs `d1-dump drill --backend sqlite` on it, and deletes the directory. A run with no marker is skipped, as `latestDump` skips it. It prints one line per site:

```
<site> run=<run id> age_hours=<n> tables=<n> rows=<n> PASS
<site> run=<run id> age_hours=<n> tables=<n> rows=<n> FAIL (<first failing check>)
<site> FAIL (<reason>)
```

`run` is the run drilled, `age_hours` is the marker's `exported_at` to now, `tables` and `rows` come from the marker. `PASS` means the drill exited 0. `FAIL (counts: ...)` and the other check names are the drill's own, listed above. A line with no run id means no complete run was found or the bucket could not be opened or read (the reason follows). The exit code is 1 when any site failed, and 2 for an unknown argument or site (nothing is drilled). txasm, dustinedwards and foxing join `SITES` as their backup jobs land.

Checks the old rehearsal made and where each lives now:

| Old check | Now |
| --- | --- |
| tables equal the migrations' tables, both directions | `tables-mismatch` at dump time (`test/backup.test.ts`, "tables-mismatch: missing none; unlisted stray"), and the drill restores exactly the tables the marker lists |
| table counts against the dump | the drill's `restore` and `counts` checks |
| FTS agreement through `_docsize`, and a search | the drill's `fts` and `search` checks |
| dump freshness, 26 hours | the drill's `dump` check |
| rows carry the table's columns | the drill (d1-dump v0.3.0 refuses a table whose rows lack, or add to, the columns `_schema.json` gives it, including a column missing from every row), and `dump-invariants` checks that every row carries the same columns |
| seeded rows emptied before import | not needed: the drill restores from `_schema.json`, which has no seed rows, and a leftover row would fail `counts` |
| sidecars, marker lists the files, shuffled files, torn snapshot, zero documents | `scripts/dump-invariants.ts` |

The backup-safety rule is unchanged and lives in `src/backup.ts`: a destructive step (the prune) refuses unless `documents` is above zero and the pinned FTS probe matches.

Recovering one document rarely needs any of this: read its latest `document_versions` snapshot back.
