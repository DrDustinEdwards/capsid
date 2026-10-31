# The system model and its public documents

Ruling: capsid/rulings/system-explorer-2026-10-10.md (answers 1, 2 and 15), and Dustin on 2026-10-23: "do not exclude private repos", "fully wired just like the public ones". Design: capsid/research/design-system-explorer.md, sections 1 and 2.

## The model

`system/model.json` is the one hand-written model of Dustin's systems, every repo included: each system's name, short name (for the phone map), family, ring, description, domain and repos; each system's containers; and the relationships between them. Every map and diagram is drawn from it. The order of `systems` is the map's order, and on dustinedwards.info the systems people use are grouped by family (sites, products, writing, plumbing), each group chained in that order, so a site sits beside its admin. It changes by pull request.

The file is in a public repo, so it holds only what may be published: what each system is for and what it is made of, never a secret, a resource id or an internal address. That holds for a private repo's system too.

The schema is Zod, in `src/system-model.ts`. `system/model.schema.json` is generated from it (`node --import ./test/resolve-ts.mjs scripts/write-system-schema.mjs`) for editors, and `test/system-model.test.ts` fails when the committed file differs from the schema the Worker enforces. The same test file checks the committed model: ids unique, every relationship's ends exist, and every container's system exists.

### Flows

A flow (design section 4) is an ordered walk over the model, drawn by the explorer: `flows[]` with an `id`, a `name`, an optional `description` and two to twenty `steps`. A step names one relationship already in the model by its `from`, `kind` and `to`, goes `toward` one of its two ends, says what happens in `text`, and may `lights` up to eight containers it touches. The schema refuses a step on a relationship the model does not have, one toward neither end, and a light that is not a container, so a flow can never show a connection the map does not. In the public document a step is `{relationship, toward, text, lights?}`, the relationship by its derived id.

The first flow is `job-life`, a job from posted to its claims checked against GitHub. It runs over Capsid's containers and two `external` ones, Agents and GitHub (Dustin, 2026-10-11: external boxes with ordinary edges, drawn outside the dashed boundary). The explorer lists them under "Outside it", apart from Capsid's own parts. Capsomer's map draws them inside the boundary until its release that places `external` boxes outside it; the explorer and dustinedwards.info take that release.

## The filter

`toPublic` in `src/system-model.ts` builds the public document by picking named fields into new objects, never by copying and deleting, so a field nobody listed cannot pass through.

1. A system is public only when GitHub reports every repo it lists as public. Anything else, a repo GitHub did not list included, makes it private.
2. Every system, container, relationship and flow is published. A private system carries no repo link, and its code map is never read (below); nothing else differs.
3. Every output relationship id is derived from its ends and kind, never copied from the file.
4. A public system marked `hide_repo_link` is published without its repo link (answer 15: Skills).

Proven in `test/system-model.test.ts`: a private system published whole without its repo, under both of GitHub's answers, and a strict schema that refuses a key toPublic does not write, a repo link on a private system included.

## The drift check

The model is written by hand, so the daily maintenance pass compares it with what Capsid and GitHub know (`src/model-drift.ts`; rules `model-drift` and `model-not-checked` in the Portal's Maintenance list, docs/work-queue.md). It lists and never edits: the model changes by pull request. A repo is left off only when the model's `left_off` list names it (Dustin keeps bsw, Recova, its MCP and the old Foxing admin off, 2026-10-23); that list is never published, and a repo in it that GitHub stops listing is named so the entry goes.

## The aggregate numbers

`src/public-stats.ts` computes them in the same daily build. Every window is whole UTC days ending at midnight, so a day's activity appears only the next day and nothing in the document says when anything happened. A rate or median over fewer than ten rows (`FLOOR`) is null. The only strings are `as_of` (a date) and `capsid.sha7` (already public on /health).

| Field | From | Why it cannot leak |
| --- | --- | --- |
| `jobs.completed_7d`, `completed_30d`, `failed_30d`, `completed_by_week` (8 whole weeks, oldest first) | `jobs` by status and `updated_at` | counts across every namespace and agent |
| `jobs.failed_by_week`, `gates.waits_by_week` (the same 8 weeks) | `jobs` by status, `job_touches` that ended a wait | counts across every namespace, agent and command |
| `verification.agreement_by_week` (the same 8 weeks) | `job_evaluations` by `recorded_at` | a rate per week, null for a week under ten |
| `jobs.open`, `jobs.blocked` | `jobs` by status, read once a day (answer 5) | one daily count, attributable to nothing |
| `jobs.median_duration_minutes_30d` | `job_outcomes.duration_minutes` | a median, null under ten |
| `verification.evaluations_90d`, `agreement_rate_90d` | `job_evaluations.agreement`: agree over agree plus disagree | a count and a rate over every agent |
| `verification.pr_merge_rate_90d`, `ci_green_rate_90d` | `job_outcomes`, verified fields only, as `src/agent-record.ts` reads them | rates over every agent, null under ten |
| `gates.waits_30d`, `median_wait_minutes_30d`, `share_ended_by_policy_30d` | `job_touches` that ended a wait | no command, class or actor |
| `sites.watched`, `uptime_7d`, `slots_measured_7d` | the watcher snapshot's half-hour rings, measured slots only | one number across sites, no site or error text |
| `store.documents`, `store.namespaces` | row counts | no names |
| `systems.public`, `systems.private` | the filtered model's counts | counts |

The three weekly series are optional in the schema only so a document written before them (2026-10-23) still parses.

Deploy counts are left out: the snapshot keeps each site's newest ten deploys only, so a 30-day count would be wrong.

`test/public-stats.test.ts` walks the document's keys against this list both ways, checks that the only strings are the date and the sha, and covers the windows, the floor and the verified-only rates.

## The code maps

devkit's `code-map` workflow (design section 5) writes `code-map.json` to an orphan `code-map` branch in each repo that calls it, after each push to its default branch: per module its lines, imports and whether it sits in an import cycle; per function its cyclomatic complexity, coverage, CRAP and mutation score, null where nothing measured it. Mutation runs weekly, so a map can carry an older run's scores: `mutated` names that run's commit and day, and a function changed since it has `stale: true` and no score. The same daily build reads that file through the GitHub App for every repo of a public system (`publicRepos`, rule 1 of the filter) and never for a private system's, so a private map cannot be published (rule 2). `src/public-code.ts` parses each file, against the schema in `src/public-code-schema.ts`, field by field into new objects, so a key the schema does not name is dropped; module paths must be repo-relative; and the map must name the repo it was read from. A repo with no branch or file is left out. A map that fails the parse keeps the last good code document and shows as refused in the run ledger, without holding back the model or the numbers. The design named one document per repo; one document for all of them reuses the model's route and cache unchanged, and the explorer's build reads it once. Proven in `test/public-code.test.ts`, with a canary planted in unnamed fields.

## The daily build and the routes

The `public-build` step on the five-minute tick (`src/public-data.ts`, task `public-build` in the run ledger) runs once a UTC day. It reads every repo's visibility through the GitHub App's metadata-only listing (`listInstalledRepos`), runs the bundled model through `toPublic`, computes the numbers, and stores both in `APP_KV` under `public:model:v1` and `public:stats:v1`, then the code maps under `public:code:v1`. Later in the day the code maps alone are rebuilt each hour (`public:code:last` stamps the attempt), because a repo publishes a new map after every push. Every read happens before any write, so a failed read leaves the last good documents served and the day's build retries on the next tick.

`GET https://mcp.dustinedwards.info/public/model/v1.json`, `/public/stats/v1.json` and `/public/code/v1.json` each serve their stored document and never compute anything: the colo's cache first (keyed without the query string), then a per-IP limit (`PUBLIC_DATA_RULES` on the `RATE_LIMITER` Durable Object: 120 an hour, 1,000 a day, failing closed), then the KV read. It answers 503 `{"error":"not computed yet"}` before the first build. `Cache-Control: public, max-age=3600, s-maxage=3600`; no CORS header, because the explorer's and dustinedwards.info's builds read it, not browsers (answer 4). All three share one rate budget. The routes are listed in `UNGATED_ROUTES` (`src/scope.ts`) and `MCP_HOST_PATHS` (`src/mcp-host.ts`). Proven in `test/public-data.test.ts`.

## Who reads them

The explorer at capsid.dustinedwards.info (`explorer/`, explorer/README.md) builds from both documents once a day and checks each against `PublicModelSchema` and `PublicStatsSchema` before it writes a page, so a document the filter could not have produced stops the build. dustinedwards.info's `/systems` reads the model through a reviewed pull request (its `system-model.yml`).
