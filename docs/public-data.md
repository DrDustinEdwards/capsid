# The system model and its public documents

Ruling: capsid/rulings/system-explorer-2026-10-10.md (answers 1, 2, 6, 7 and 15). Design: capsid/research/design-system-explorer.md, sections 1 and 2.

## The model

`system/model.json` is the one hand-written model of Dustin's systems: each system's name, short name (for the phone map), family, ring, domain and repos; Capsid's containers; and the relationships between them. Every map and diagram is drawn from it. It changes by pull request.

The file holds public-safe facts only. A private system is written as its public name, short name, domain, family and ring, plus the repos the drift check reads, and the schema refuses a description on it. A private repo with no public product (answer 7) is never named in this file.

The schema is Zod, in `src/system-model.ts`. `system/model.schema.json` is generated from it (`node --import ./test/resolve-ts.mjs scripts/write-system-schema.mjs`) for editors, and `test/system-model.test.ts` fails when the committed file differs from the schema the Worker enforces. The same test file checks the committed model: ids unique, every relationship's ends exist, every container's system exists, and no repo without a public product named.

## The filter

`toPublic` in `src/system-model.ts` builds the public document by picking named fields into new objects, never by copying and deleting, so a field nobody listed cannot pass through.

1. A system is public only when the model says `public: true` and GitHub reports every repo it lists as public. Anything else, a repo GitHub did not list included, makes it private.
2. A private system is `id`, `name`, `short`, `domain`, `family`, `ring` and `private: true`, nothing more (`PRIVATE_SYSTEM_KEYS`). Its containers are dropped.
3. A relationship with a private end survives only between two systems, with no title (answer 6). Every output relationship id is derived from its ends and kind, never copied from the file.
4. A public system marked `hide_repo_link` is published without its repo link (answer 15: Skills).

Proven in `test/system-model.test.ts`: the canary fixture (a private system carrying a marker string in every field it has, and in containers and titles that touch it, none of which reaches the output), visibility both ways, an unmodelled repo, the strict key walk, and 500 seeded random models.

## The drift check

The model is written by hand, so the daily maintenance pass compares it with what Capsid and GitHub know (`src/model-drift.ts`; rules `model-drift` and `model-not-checked` in the Portal's Maintenance list, docs/work-queue.md). It lists and never edits: the model changes by pull request. Repos deliberately left off (answer 7) are listed in the Capsid document `capsid/system/unlisted.md`, which stays private, as `- owner/name` lines.

## The aggregate numbers

`src/public-stats.ts` computes them in the same daily build. Every window is whole UTC days ending at midnight, so a day's activity appears only the next day and nothing in the document says when anything happened. A rate or median over fewer than ten rows (`FLOOR`) is null. The only strings are `as_of` (a date) and `capsid.sha7` (already public on /health).

| Field | From | Why it cannot leak |
| --- | --- | --- |
| `jobs.completed_7d`, `completed_30d`, `failed_30d`, `completed_by_week` (8 whole weeks, oldest first) | `jobs` by status and `updated_at` | counts across every namespace and agent |
| `jobs.open`, `jobs.blocked` | `jobs` by status, read once a day (answer 5) | one daily count, attributable to nothing |
| `jobs.median_duration_minutes_30d` | `job_outcomes.duration_minutes` | a median, null under ten |
| `verification.evaluations_90d`, `agreement_rate_90d` | `job_evaluations.agreement`: agree over agree plus disagree | a count and a rate over every agent |
| `verification.pr_merge_rate_90d`, `ci_green_rate_90d` | `job_outcomes`, verified fields only, as `src/agent-record.ts` reads them | rates over every agent, null under ten |
| `gates.waits_30d`, `median_wait_minutes_30d`, `share_ended_by_policy_30d` | `job_touches` that ended a wait | no command, class or actor |
| `sites.watched`, `uptime_7d`, `slots_measured_7d` | the watcher snapshot's half-hour rings, measured slots only | one number across sites, no site or error text |
| `store.documents`, `store.namespaces` | row counts | no names |
| `systems.public`, `systems.private` | the filtered model's counts | counts |

Deploy counts are left out: the snapshot keeps each site's newest ten deploys only, so a 30-day count would be wrong.

`test/public-stats.test.ts` walks the document's keys against this list both ways, checks that the only strings are the date and the sha, and covers the windows, the floor and the verified-only rates.

## The daily build and the routes

The `public-build` step on the five-minute tick (`src/public-data.ts`, task `public-build` in the run ledger) runs once a UTC day. It reads every repo's visibility through the GitHub App's metadata-only listing (`listInstalledRepos`), runs the bundled model through `toPublic`, computes the numbers, and stores both in `APP_KV` under `public:model:v1` and `public:stats:v1`. Every read happens before any write, so a failed read leaves the last good documents served and the day's build retries on the next tick.

`GET https://mcp.dustinedwards.info/public/model/v1.json` and `/public/stats/v1.json` each serve their stored document and never compute anything: the colo's cache first (keyed without the query string), then a per-IP limit (`PUBLIC_DATA_LIMIT`: 120 an hour, 1,000 a day, failing closed), then the KV read. It answers 503 `{"error":"not computed yet"}` before the first build. `Cache-Control: public, max-age=3600, s-maxage=3600`; no CORS header, because the explorer's and dustinedwards.info's builds read it, not browsers (answer 4). Both share one rate budget. The routes are listed in `UNGATED_ROUTES` (`src/scope.ts`) and `MCP_HOST_PATHS` (`src/mcp-host.ts`). Proven in `test/public-data.test.ts`.
