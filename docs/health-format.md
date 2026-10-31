# Health format

One format for a site's health route, defined here so the watcher's `sha` live check (docs/live-checks.md) reads every site the same way. Code: `src/health-format.ts`; tests: `test/health-format.test.ts`.

## The body

JSON. The family's format is site-runtime's `/health` (the IETF health-check draft), sent as `application/health+json`:

| Field | Value |
| --- | --- |
| `status` | `"pass"`, `"warn"` or `"fail"` |
| `ok` | a boolean |
| `sha` | the deployed commit as a string, or absent |
| `db`, `backup`, `time` | optional; `backup` is `{ last_ok, age_hours, warning? }` |
| `checks` | `[{ name, status, detail? }]` |

The watcher also reads the bodies sites sent before it: no `status`, only `ok`, `backup.warning` and `checks` whose entries carry `ok`, and Capsid's own, whose `status` is `"ok"`, `"degraded"` or `"down"`. Either JSON content type is read. Nothing secret goes in the body: no token, no binding id, no row content.

## The response

- `Cache-Control: no-store`, so a poll after a deploy reads the new version.
- `503` only on `fail` (or Capsid's `down`, and its `degraded` when D1 or FTS fails, which the live gate relies on). The watcher reads the body whatever the code.

## How the watcher reads it

`parseHealth` (`healthOf` for a value already parsed) returns a status, the sha and the problem:

- `pass` or `ok` is ok, unless `ok` is `false` or the body carries a backup warning: then it is degraded.
- `warn` or `degraded`, or no `status` with `ok: false`, is degraded.
- `fail` or `down` is down.
- The problem is the names of the checks whose `status` is warn or fail, or whose `ok` is `false`, and the backup warning, joined. The probe shows it as the site's error and the phone alert names it.

The probe (`probeSite`, `src/ops-snapshot.ts`) calls a 2xx ok or degraded as the body says. A non-2xx answer or a `fail` body is a failed health route, and the probe reads the root: a root that answers 2xx makes the site degraded, and one that does not makes it down. A body that is not JSON, or a field of the wrong type, reads as absent, so a 2xx with no readable body is ok and a site that reports no sha is the `live-sha-unreported-<site>` finding, never a crash in the probe. A sha is cut to 40 characters; a short sha is allowed and matches by prefix once it is 7 characters or more.

A health path is a path on the site's origin, or an https URL where a site serves its health on another host (Carrel's public one is on `carrel-mcp.dustinedwards.info`, its app being behind Access); the root fallback stays on the origin.

## Where each site stands

Read on 2026-10-30: foxing, foxhound, txasm, bsw, julieedwards, germomics and Carrel answer the older `ok` body (foxhound, txasm, bsw, julieedwards and Carrel with a sha), dustinedwards.info answers it at `/api/health` with `checks`, and Capsid answers its own. Each moves to site-runtime's body as it takes that version. A `sha` line in `capsid/policy/live-checks.md` is the seat's to add once a site reports one.
