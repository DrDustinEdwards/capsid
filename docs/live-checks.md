# Live checks

The watcher's fourth kind of read: what the deployed sites actually serve, read every watcher pass. Code: `src/live-checks.ts`, `src/live-findings.ts`.

## What it checks

| Rule              | A finding when                                                                                                                                                                                                         | Fingerprint                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `beacon <path>`   | a CSP header on that page does not let the beacon load from its script path prefix or report to the site itself (site-runtime's C15)                                                                                   | `live-csp-beacon-<site>-<path>`                              |
| `analytics`       | the site's host has no Web Analytics site in the account, or its automatic setup (`auto_install`) is off, or its ruleset is switched off                                                                               | `live-analytics-missing-<site>`, `live-analytics-off-<site>` |
| `analytics`       | Cloudflare could not be read (no token, a 403 for the missing permission)                                                                                                                                              | `live-analytics-unread-<site>`                               |
| `nobeacon <path>` | the page carries a beacon (private and signed-in pages stay out of analytics)                                                                                                                                          | `live-beacon-present-<site>-<path>`                          |
| `headers <path>`  | the page lacks a header of the OWASP standard set, or its enforced CSP fails the package's policy checks (no enforced policy, `'unsafe-inline'` or `'unsafe-eval'` in scripts, no `object-src 'none'`, no report sink) | `live-headers-<site>-<path>`                                 |
| `sha`             | the site's health route reports a sha that is not the default branch head, and the head was committed more than 45 minutes ago                                                                                         | `live-sha-drift-<site>-<head7>`                              |
| `sha`             | the site's health route reports no sha                                                                                                                                                                                 | `live-sha-unreported-<site>`                                 |

A page that cannot be read is not clean and not dirty: `live-page-unread-<site>-<path>` (an error, a non-2xx answer, a redirect off the site, a body that is not HTML or is over 1 MiB), and the check does not count as run, so an open finding is not cleared on no evidence. For a `nobeacon` page a login redirect, a 401 or a 403 is the wanted answer: the page is not served to the public, so it counts as read. A site that is down this pass is the `site probes` check's finding and its rules are skipped.

The beacon is not counted: Cloudflare injects it at the edge for browser traffic, and a Worker's own request does not receive the injected copy. So a `beacon` rule checks only the CSP, and `analytics` checks what makes Cloudflare inject it, the zone's Web Analytics automatic setup (`GET /accounts/{id}/rum/site_info/list`). That needs **Account / Account Settings / Read** on `CF_OPS_TOKEN` ([portal.md](portal.md), "The Cloudflare token"); without it the rule files `live-analytics-unread-<site>`, never a pass. The list is read once per pass and the site token in it is never kept.

The CSP rule is site-runtime's `checkSecurityHeaders`, graded as if the site declared `cloudflareWebAnalytics`: `script-src` must list the beacon's path prefix (`/beacon.min.js/v...`) and `connect-src` (or `default-src`) must include `'self'`. A site not proxied through Cloudflare is not covered. Only enforced policies are judged, not `Content-Security-Policy-Report-Only`.

The `headers` rule runs `checkSecurityHeaders` from `@dustinedwards/site-runtime/check` on the page's response headers, so the OWASP defaults live in that package alone. One finding per page lists up to 12 failed checks. A site that deliberately differs on a header is judged against the standard.

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
- `sha` is for a site that deploys on merge and whose health route reports its sha in the standard format ([health-format.md](health-format.md)). A site that ships by hand gets no `sha` line. `capsid` is refused: its own deploy is the `master head` check.
- Reads only. A finding about the config itself (`live-config-invalid`, `live-config-unknown-site-<namespace>`) is an alert-class finding, remembered like the others. Every other live finding (headers, beacon, CSP, sha, analytics, unread pages) is a digest-class finding, listed in the weekly digest per site (the Portal's Agents, Activity tab, and the Monday email), because a hygiene finding is not something to drop everything for. See [autonomy.md](autonomy.md).

## What it cannot see

- Whether a beacon is actually on a page a browser loads. The edge injects it after the Worker's request is answered, so a Worker cannot see it; the `analytics` rule reads the setting instead, and the CSP rule reads whether the policy would let it run. Neither proves a page rendered it. A `nobeacon` page is judged on the delivered HTML only, so an edge-injected beacon on it is invisible too; Cache-Control `no-transform` on such pages is what keeps the edge from adding one.
- A beacon a page adds with inline script is not counted. Only a script tag naming the beacon host counts, and only for `nobeacon`.
- Pages behind Cloudflare Access cannot be read as a signed-in user. That needs an Access service token.

## Each pass logs what it read

A JSON log line with `event` `WATCHER_LIVE` and a `message` of `WATCHER_LIVE pages <read>/<expected> shas <read>/<expected> analytics <read>/<expected> findings <n>`. No findings over zero pages read is not a clean bill: the count is the other half of the check.

## The signed-in crawl

devkit's scoreboard grades Capsid Portal from outside, and a crawl with no session sees only the sign-in redirect. So once an hour the tick runs `src/signed-in-crawl.ts`. It grades the pages behind the sign-in with site-runtime's shared crawl (`./signed-in-crawl`), against the Portal's registry entry (`capsid-portal`). It stores the report in KV and serves it at `https://mcp.dustinedwards.info/reports/signed-in-security.json`. devkit reads it there as the reported check `signed-in-security` (devkit `live/areas.json`). The report holds findings only: no page body, cookie or token.

- **Portal.** The Portal is this Worker, and its session is Capsid's own cookie, so an Access service token can't pass it. The crawl calls this Worker's fetch handler in-process, with a Portal session minted for `ADMIN_EMAIL`. That session lasts for one request and never leaves the isolate. The crawl sends GETs of the page, its first script and `/api/namespaces`. It also sends R4's two probes: a `text/plain` and a form body to each JSON action, which must answer 415 (`requireJson`, run before the body, the CSRF pair or the session's rights are read).
- **Desk.** Carrel grades Desk itself the same way, in-process as its Owner, and publishes `https://carrel-mcp.dustinedwards.info/reports/signed-in-security.json`; devkit reads Desk's cell there (`site_reports`). No Access service token is involved.
