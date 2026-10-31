# Live checks

The watcher's fourth kind of read: what the deployed sites actually serve. Dustin ran these by hand after a deploy (PowerShell for the beacon count and the CSP header on four sites). The Worker now reads them every watcher pass. Ruled 2026-10-04, D5 of `capsid/research/design-automation-for-speed.md`. Code: `src/live-checks.ts`; tests: `test/live-checks.test.ts`.

## What it checks

| Rule | A finding when | Fingerprint |
| --- | --- | --- |
| `beacon <path>` | a CSP header on that page does not let the beacon load from its script path prefix or report to the site itself (site-runtime's C15) | `live-csp-beacon-<site>-<path>` |
| `analytics` | the site's host has no Web Analytics site in the account, or its automatic setup (`auto_install`) is off, or its ruleset is switched off | `live-analytics-missing-<site>`, `live-analytics-off-<site>` |
| `analytics` | Cloudflare could not be read (no token, a 403 for the missing permission) | `live-analytics-unread-<site>` |
| `nobeacon <path>` | the page carries a beacon (private and signed-in pages stay out of analytics) | `live-beacon-present-<site>-<path>` |
| `headers <path>` | the page lacks a header of the OWASP standard set, or its enforced CSP fails the package's policy checks (no enforced policy, `'unsafe-inline'` or `'unsafe-eval'` in scripts, no `object-src 'none'`, no report sink) | `live-headers-<site>-<path>` |
| `sha` | the site's health route reports a sha that is not the default branch head, and the head was committed more than 45 minutes ago | `live-sha-drift-<site>-<head7>` |
| `sha` | the site's health route reports no sha | `live-sha-unreported-<site>` |

A page that cannot be read is not clean and not dirty: `live-page-unread-<site>-<path>` (an error, a non-2xx answer, a redirect off the site, a body that is not HTML or is over 1 MiB), and the check does not count as run, so an open finding is not cleared on no evidence. For a `nobeacon` page a login redirect, a 401 or a 403 is the wanted answer: the page is not served to the public, so it counts as read. A site that is down this pass is the `site probes` check's finding and its rules are skipped.

The beacon is no longer counted. Cloudflare injects it at the edge for browser traffic, and a Worker's own request does not receive the injected copy: on the first supervised pass (2026-10-04) the count read 0 on germomics and foxhound where a browser-style fetch read exactly one on each. So a `beacon` rule now checks only the CSP, and the `analytics` rule checks the thing that makes Cloudflare inject it: the zone's Web Analytics automatic setup, read with `GET /accounts/{id}/rum/site_info/list` (developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/list/). That read needs **Account / Account Settings / Read** on `CF_OPS_TOKEN` (docs/portal.md, "The Cloudflare token"); without it the rule files `live-analytics-unread-<site>`, never a pass. The list is read once per pass however many sites have the rule, and the site token in it is never kept.

The CSP rule is site-runtime's check (`checkSecurityHeaders`, item C15), graded as if the site declared `cloudflareWebAnalytics`: `script-src` must list the beacon's path prefix, which the edge injects from (`/beacon.min.js/v...`), and `connect-src` (or `default-src`) must include `'self'`, where a Cloudflare-proxied site's beacon reports. A site not proxied through Cloudflare is not covered. Only enforced policies are judged; a `Content-Security-Policy-Report-Only` header is not.

The `headers` rule runs `checkSecurityHeaders` from `@dustinedwards/security-headers` (a git dependency, pinned by tag) on the page's response headers. The OWASP defaults and the test vectors live in that package alone: the watcher imports them, so a refresh of OWASP's data in the package changes this check with no second copy to keep in step. One finding per page lists up to 12 failed checks. A site that deliberately differs on a header is judged against the standard until the rule takes an override; add one when the first such site needs it.

## The document

`capsid/policy/live-checks.md` in the store, read each pass. No document, or one that does not parse, and no live check runs: nothing is fetched on a guess. An invalid document is itself one finding (`live-config-invalid`), naming the line. Only lines that begin `- site ` are rules; the rest is prose.

```
- site <namespace> beacon <path>
- site <namespace> nobeacon <path>
- site <namespace> analytics
- site <namespace> headers <path>
- site <namespace> sha
```

- `<namespace>` is a site configured in the Portal's Settings (`ops_sites`). A rule for any other name is `live-config-unknown-site-<namespace>`, since it can never run.
- `<path>` starts with `/` and holds letters, digits and `. _ ~ / % -`. No query, no host: the check fetches the site's configured origin plus this path and nothing else.
- Up to 20 page rules, 20 analytics rules and 6 sha rules, because each is a fetch or a GitHub read inside one pass.
- `sha` is for a site that deploys on merge and whose health route reports its sha in the standard format (docs/health-format.md). A site that ships by hand would be flagged on every merge, so it gets no `sha` line. dustinedwards now deploys from its deploy workflow after green CI on main (`workflow_run`, since 2026-09-23), so it can take a `sha` line once its health route reports the sha in that format. `capsid` is refused: its own deploy is the `master head` check.
- Reads only. A finding about the config itself (`live-config-invalid`, `live-config-unknown-site-<namespace>`) is a job posted by the watcher, deduplicated and remembered like the others. Every other live finding (headers, beacon, CSP, sha, analytics, unread pages) posts no job: it is remembered open with no job and listed in the weekly digest per site (the Portal's Needs you page, and the Monday email), because a hygiene finding is not something to drop everything for. See docs/autonomy.md, "The watcher".

## What it cannot see

- Whether a beacon is actually on a page a browser loads. The edge injects it after the Worker's request is answered, so a Worker cannot see it; the `analytics` rule reads the setting instead, and the CSP rule reads whether the policy would let it run. Neither proves a page rendered it. A `nobeacon` page is judged on the delivered HTML only, so an edge-injected beacon on it is invisible too; Cache-Control `no-transform` on such pages is what keeps the edge from adding one.
- A beacon a page adds with inline script is not counted. Only a script tag naming the beacon host counts, and only for `nobeacon`.
- What the Worker's request itself contains (headers, any `cf-*` or Speed marker) was not recorded from inside a Worker in this change; the evidence is the false first pass above. The first pass after the `analytics` rules are added is supervised the same way.
- Pages behind Cloudflare Access cannot be read as a signed-in user. That needs an Access service token (D6), which Dustin creates himself.

## Each pass logs what it read

A JSON log line with `event` `WATCHER_LIVE` and a `message` of `WATCHER_LIVE pages <read>/<expected> shas <read>/<expected> analytics <read>/<expected> findings <n>`. No findings over zero pages read is not a clean bill: the count is the other half of the check.
