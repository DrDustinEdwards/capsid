# Backups and restore

D1 Time Travel gives 30-day point-in-time recovery. Backups are for longer retention and portability.

## The daily dump

The 09:00 UTC cron exports the database to `MEDIA`:

- `backups/json/<timestamp>/<table>.json.gz`: one gzipped JSON file per table, plus `_schema.json` (the CREATE statements) and `_kv.json`. The dump is [`@dustinedwards/d1-dump`](https://github.com/DrDustinEdwards/d1-dump)'s `runCheckedBackup`, the job every site runs, with Capsid's own checks beside it (`tables-mismatch`, the preflight, the lease).
- `backups/markdown/<namespace>/<path>`: a Markdown mirror of every document body, tracking current state.

`TABLES` in `src/backup.ts` is the list of dumped tables; `test/backup.test.ts` checks it against `migrations/`. A run whose dumped tables differ from it is refused as `tables-mismatch`. The dump skips `documents_fts` and its shadow tables (FTS5 derives them from `documents`), `d1_migrations`, and `push_subscriptions`, whose rows hold each device's push keys: after a restore each device turns phone alerts on again.

A run is complete when it carries `_complete.json`, written last and only when the preflight passed. Retention is d1-dump's graduated policy with Capsid's numbers (`DUMP_RETENTION`): the newest complete run of each of the last 14 days, 4 ISO weeks and 3 calendar months, about 17 runs. Any other run is deleted whole. The newest complete run is never pruned, and nothing is pruned while no run is complete. A run with no marker holds no slot and is kept only inside the 14-day window. If the preflight refuses the prune (no documents, or the FTS probe failed), the run writes its dumps and `prune_refused` names the reason.

Each put to `MEDIA` is tried up to three times, because R2 now and then refuses one with error 10001. A failed multipart part still fails the run.

After the export, `document_versions` rows older than 90 days and `audit_log` rows older than 365 days are pruned, so every pruned row is in a retained dump.

The only way a backup runs is the daily cron. There is no on-demand route.

## The Amazon copy

The private `DrDustinEdwards/capsid-backups` repository copies every site's newest complete dump, and each site's media under `files/`, into an Amazon S3 bucket with Object Lock, so they survive loss of the Cloudflare account. Its workflows, CloudFormation stack, tiers (14 daily, 8 weekly, 6 monthly) and monthly restore drill live there.

This Worker mints that repo's R2 read credential at `POST /backup/credential` and receives its report. The request may name a `site`; the credential is then read-only on that site's bucket (the pinned table in `src/offaccount.ts`) and its `backups/json/` and `files/` prefixes, and any other site is refused with 400. With no site it is Capsid's (`capsid-media`). A request may instead name an `audit` log from `OFFACCOUNT_AUDIT_SOURCES`: the MCP tool-call buckets, whose Durable Object rows are pruned after 90 days. Naming both is refused.

**Dispatch.** GitHub can start `offaccount.yml` hours late. After 11:25 UTC the tick asks whether the workflow has a run today and, if not, dispatches it on `master` through the GitHub App (Actions: Write, [bootstrap.md](bootstrap.md)). Once a day it also probes the permission by dispatching a branch that does not exist: 422 means the App may dispatch, 403 or 404 means it may not. A refusal is retried an hour later and recorded as `offaccount-dispatch` (`src/offaccount-dispatch.ts`).

**Measurement.** The Worker holds no AWS key. Every 6 hours capsid-backups' `watch.yml` lists the bucket with a list-only role and posts `POST /backup/offaccount-report`, signed with the backup key and replay-protected. For every site in `OFFACCOUNT_SOURCES` it names the newest complete copy and its size, up to 14 recent daily copy sizes, and the newest weekly and monthly copies. The Worker refuses a report that omits or adds a site and stores it in `APP_KV` as `offaccount:report`. Every half hour the watcher judges it (`src/watcher-detect.ts`):

- newest copy older than `OFFACCOUNT_LATE_HOURS` (30): `offaccount-late-<site>`, a Portal warning; older than `OFFACCOUNT_STALE_HOURS` (36): `offaccount-stale-<site>`, an alert; none: `offaccount-no-copy-<site>`;
- newest copy under a quarter of, or over double, the median of at least three before it: `offaccount-size-<site>`;
- a report older than `OFFACCOUNT_REPORT_STALE_HOURS` (13): `offaccount-report-stale`; none: `offaccount-no-report`;
- no passing `drill.yml` run (restores every site's newest copy) in `OFFACCOUNT_DRILL_STALE_DAYS` (35): `offaccount-drill-stale`;
- a D1 database some Worker binds (`src/system-resources.ts`) that no `OFFACCOUNT_SOURCES` row covers: `offaccount-uncovered-<database>`.

A successful copy run that finished after the report arrived holds the age verdict until the next report, because `watch.yml` can list the bucket mid-upload. Each read is its own check (`offaccount`, `offaccount drill`, `offaccount coverage`), so one that fails posts and clears nothing. The verdict is on the dump, not the attempt: a backup credential request succeeding says nothing about whether the copy landed. `OFFACCOUNT_STALE_HOURS` is not `BACKUP_STALE_HOURS`, which is the local dump's 26 hours measured from a key this Worker writes.

## What the dump leaves out

The dump is D1 plus one KV pin (`backup:last-ok`, in `_kv.json`).

- **`OAUTH_KV`**: clients, grants and tokens. Lost, not rebuilt: every MCP client signs in and registers again.
- **`APP_KV`**: caches and last reads, each rewritten by its next read or pass. Two cost a little more: `push:state` is the record of alerts sent, so an open alert is sent once more, and `site-pulse:state` holds the down counts, so a site already down alerts again after two probes. Settings set by hand fall back to their defaults.
- **`RATE_LIMITER`** (Durable Object): per-caller counters. Lost means reset.
- **`TOOL_CALL_LOG`** (Durable Object, SQLite): every MCP tool call. Not dumped; the object's own 30-day point-in-time recovery is the only copy. The dumped `audit_log` keeps every write and its caller, so a restore loses the record of reads and refusals.
- **`MEDIA`** (R2) is the destination, copied off-account by capsid-backups.

## Bucket locks

Each bucket that holds d1-dump runs has one R2 lock rule, `backups-json-13d`: prefix `backups/json/`, 13 days. A delete or overwrite there (a buggy prune, a leaked R2 token) is refused for a dump's first 13 days; older dumps are protected by the Amazon copy. Nothing else in a bucket is locked: the rule never covers `backups/markdown/` or media. Locks guard against object-level access, not against a token that can edit the bucket's configuration. Buckets: `dustinedwards-backups`, `carrel-backups`, `capsid-media`, `germomics-backups`, `txasm-books`, `foxing-backups`, `foxhound-backups`, `julieedwards-backups`.

```
npx wrangler r2 bucket lock list <bucket>
npx wrangler r2 bucket lock add <bucket> --name backups-json-13d --prefix backups/json/ --retention-days 13
npx wrangler r2 bucket lock remove <bucket> --name backups-json-13d
```

`add` appends a rule, so list first. Add jurisdiction flags if a bucket has one. Do not test a lock by writing a probe object under `backups/json/`: `pruneDumps` reads any folder there as a run and tries to delete it every night.

**Why 13 days.** `pruneDumps` keeps the newest complete run of each of the last 14 UTC days, so apart from same-day duplicates the youngest object it deletes was written on day D and is deleted no earlier than 00:00 UTC on day D+14, more than 13 days later. A 14-day lock would race the 09:00 cron, so 13 is the longest whole-day lock that never refuses those deletes. A site's `pruneDumps` call must keep `daily` at 14 or more (or `retentionDays` at 14 or more) before its bucket is locked; this repository cannot see the sites' calls.

**A refused delete.** R2 answers a locked delete with error 10069, HTTP 403. From d1-dump v0.4.2 `pruneDumps` deletes each stale run on its own, `_complete.json` first, counts a locked run in `locked` and carries on; Capsid reports it as `json_backups_locked`. Any other delete failure still throws. The one delete the lock refuses in normal operation is the older run of a same-day retry, which is deleted at the first prune after it is 13 days old.

## Restore

Three paths, in the order to try them. `restore-rehearsal.yml` rehearses path 3's dump every Monday.

1. **D1 Time Travel** (last 30 days), for a bad bulk change: `wrangler d1 time-travel info capsid`, then `wrangler d1 time-travel restore capsid --bookmark=<bookmark>`. It rewinds the live database in place, so take a fresh bookmark first to keep the restore reversible.

2. **Table-scoped export and import**, to rebuild into a new database. `wrangler d1 export` refuses here: D1 does not export databases with FTS5 tables unless you pass `--compatibility sqlite3_cli_only`, and that output cannot be imported back into D1. Export the real tables one at a time, data only:

   ```
   wrangler d1 export capsid --remote --no-schema --table <table> --output export-<table>.sql
   ```

   The tables are those in `TABLES` (`src/backup.ts`), plus `push_subscriptions`, which is never dumped and restores empty. Never export `documents_fts` or its shadow tables. Create the new database and apply every file in `migrations/` in order; stopping early leaves tables or columns the import and the code need. Then run `DELETE FROM ops_sites` and `DELETE FROM shared_packages`: their migrations seed them, and the dump holds each table's whole content, so a seeded row would collide with or resurrect a dumped one. Execute the exports with `documents` first, so its triggers rebuild `documents_fts`; the rest have no triggers or foreign keys, so their order does not matter. Verify with count queries on both databases and one MATCH query on the new one, then point `wrangler.jsonc` at the new `database_id` and deploy.

3. **The R2 JSON dump**, beyond Time Travel. Wrangler cannot list R2 objects, so take the keys from the dashboard, then `wrangler r2 object get capsid-media/backups/json/<timestamp>/<table>.json.gz --file <table>.json.gz` and `gunzip`. Convert each object's `rows` to INSERT statements and follow path 2 from the create step. The same dumps are in `capsid-backups`, so this works if the Cloudflare account is gone. The `backups/markdown/` mirror is the last-resort readable copy: bodies only, no metadata.

   `_schema.json` is what the drill builds its scratch database from; a manual restore takes the schema from the migrations. `_kv.json` holds the KV pins by allowlist, one key (`backup:last-ok`); put it back with `wrangler kv key put`. A `null` value means the key was unset; `{"unreadable": "<reason>"}` means the run could not read it and it must not be restored as unset.

   The dump reads the tables in one D1 batch, so they describe one instant. `document_versions` and `audit_log` are bounded by their `MAX(id)` in that batch and paged to R2 as a multipart upload, since reading them whole exceeded the isolate's memory. `scripts/dump-invariants.ts` checks the dump weekly and refuses a torn one.

To recover one document, read its latest `document_versions` snapshot back.

## The weekly drill

`restore-rehearsal.yml` runs every Monday 11:30 UTC and on demand. It pulls the newest complete run from R2 with a minted read-only credential, then:

1. `node scripts/dump-invariants.ts` fails when `_complete.json` does not list exactly the files present, `_kv.json` is missing, an unknown underscore file rides along, a table file's `table` is not its name, a row lost a column its siblings carry, `documents` is empty, or the dump is torn (a version row for a document created after the documents read, or a `write` audit row naming a path not in the dump).
2. `npx d1-dump drill` restores the run into a scratch SQLite file (Node's `node:sqlite`) and fails when the run is older than 26 hours, a table's row count differs from the marker, `documents_fts` holds a different number of documents than `documents`, a search for a restored word finds nothing, a statement exceeds D1's 100,000-byte cap, a table's columns differ from `_schema.json`, or the scratch file cannot be deleted.

The drill holds no Cloudflare credential (Dustin, 2026-10-05): a D1 Edit token covers every database in the account, so a compromised workflow could delete production. What the SQLite backend cannot prove (D1's bound-value cap and request limits, differences between D1's SQLite build and Node's) is in d1-dump's README. The same drill against a real D1 database runs by hand, quarterly and after a change to the restore: `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npx d1-dump drill --dir <downloaded run> --backend d1`. A killed run leaves a `restore-drill-*` database; remove it with `npx wrangler d1 delete <name>`.

## Drill every site

```
npx wrangler login
node scripts/drill-all.ts                           # every site
node scripts/drill-all.ts --site carrel --site foxhound
```

Run it after 04:00 UTC on a night the sites' crons have run, so each bucket holds a fresh run. For each site in `SITES` (`scripts/drill-all.ts`) it opens the bucket through wrangler's `getPlatformProxy`, finds the newest run that carries `_complete.json`, downloads it to a temp directory, runs `d1-dump drill --backend sqlite` and deletes the directory. It prints one line per site:

```
<site> run=<run id> age_hours=<n> tables=<n> rows=<n> PASS
<site> run=<run id> age_hours=<n> tables=<n> rows=<n> FAIL (<first failing check>)
<site> FAIL (<reason>)
```

A line with no run id means no complete run was found or the bucket could not be read. The exit code is 1 when any site failed and 2 for an unknown argument or site, in which case nothing is drilled.

The backup-safety rule lives in `src/backup.ts`: the prune refuses unless `documents` is above zero and the pinned FTS probe matches.
