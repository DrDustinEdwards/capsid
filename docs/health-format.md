# Health format

One format for a site's health route, defined here so the watcher's `sha` live check (docs/live-checks.md) reads every site the same way. Code: `src/health-format.ts`; tests: `test/health-format.test.ts`.

## The body

JSON, with two fields a site must send:

| Field | Value |
| --- | --- |
| `status` | `"ok"`, `"degraded"` or `"down"` |
| `sha` | the deployed commit as a string, or `null` when the build did not record one |

Extra fields are allowed and never required (Capsid's own route adds `dirty`, `builtAt`, `schema_version`, `store`, `bindings` and `backup`). Nothing secret goes in the body: no token, no binding id, no row content.

## The response

- `Cache-Control: no-store`, so a poll after a deploy reads the new version.
- `200` for `ok`. `503` for `down`. `degraded` may be sent with either: Capsid's own route sends `503` when D1 or FTS fails, which the live gate relies on. The watcher reads the body, not only the code.

## How the watcher reads it

`parseHealth` returns the status and the sha, and nothing else. A body that is not JSON, or a field of the wrong type, reads as absent, so a site that does not follow the format is the `live-sha-unreported-<site>` finding and never a crash in the probe. A sha is cut to 40 characters; a short sha is allowed and matches by prefix once it is 7 characters or more.

## Where each site stands

Only Capsid answers in this format today. dustinedwards-info, carrel and germomics answer in their own shapes with no sha; foxhound, foxing, txasm, bsw and enarratio have no health route. Each adopts the format in its own D6 job. A `sha` line in `capsid/policy/live-checks.md` is the seat's to add once a site reports one.
