# The system model and its public document

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

## The daily build and the route

The `public-build` step on the five-minute tick (`src/public-data.ts`, task `public-build` in the run ledger) runs once a UTC day. It reads every repo's visibility through the GitHub App's metadata-only listing (`listInstalledRepos`), runs the bundled model through `toPublic` and stores the result in `APP_KV` under `public:model:v1`. A failed read throws before anything is written, so the last good document stays served and the day's build retries on the next tick.

`GET https://mcp.dustinedwards.info/public/model/v1.json` serves that stored document and never computes anything: the colo's cache first (keyed without the query string), then a per-IP limit (`PUBLIC_DATA_LIMIT`: 120 an hour, 1,000 a day, failing closed), then the KV read. It answers 503 `{"error":"not computed yet"}` before the first build. `Cache-Control: public, max-age=3600, s-maxage=3600`; no CORS header, because the explorer's and dustinedwards.info's builds read it, not browsers (answer 4). The route is listed in `UNGATED_ROUTES` (`src/scope.ts`) and `MCP_HOST_PATHS` (`src/mcp-host.ts`). Proven in `test/public-data.test.ts`.
