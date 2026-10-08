# Live checks

The watcher's fourth kind of read: what the deployed sites actually serve. Dustin ran these by hand after a deploy (PowerShell for the beacon count and the CSP header on four sites). The Worker now reads them every watcher pass. Ruled 2026-10-04, D5 of `capsid/research/design-automation-for-speed.md`. Code: `src/live-checks.ts`; tests: `test/live-checks.test.ts`.

## What it checks

| Rule | A finding when | Fingerprint |
| --- | --- | --- |
| `beacon <path>` | the delivered HTML has no Web Analytics beacon script, or two or more | `live-beacon-count-<site>-<path>` |
| `beacon <path>` | a CSP header on that page does not let `static.cloudflareinsights.com` load as a script | `live-csp-script-<site>-<path>` |
| `beacon <path>` | a CSP header on that page does not let the beacon report (`'self'` on a site proxied through Cloudflare, `cloudflareinsights.com` on any other) | `live-csp-report-<site>-<path>` |
| `nobeacon <path>` | the page carries a beacon (conventions 7.9: private and signed-in pages stay out of analytics) | `live-beacon-present-<site>-<path>` |
| `headers <path>` | the page lacks a header of the OWASP standard set, or its enforced CSP fails the package's policy checks (no enforced policy, `'unsafe-inline'` or `'unsafe-eval'` in scripts, no `object-src 'none'`, no report sink) | `live-headers-<site>-<path>` |
| `sha` | the site's health route reports a sha that is not the default branch head, and the head was committed more than 45 minutes ago | `live-sha-drift-<site>-<head7>` |
| `sha` | the site's health route reports no sha | `live-sha-unreported-<site>` |

A page that cannot be read is not clean and not dirty: `live-page-unread-<site>-<path>` (an error, a non-2xx answer, a redirect off the site, a body that is not HTML or is over 1 MiB), and the check does not count as run, so an open finding is not cleared on no evidence. For a `nobeacon` page a login redirect, a 401 or a 403 is the wanted answer: the page is not served to the public, so it counts as read. A site that is down this pass is the `site probes` check's finding and its rules are skipped.

The CSP rules follow Cloudflare's own list (developers.cloudflare.com/web-analytics/faq): `script-src` must allow `static.cloudflareinsights.com`, `connect-src` must allow the report endpoint. A directive a policy omits falls back to `default-src`, and a policy with neither blocks nothing. A `script-src` with `'strict-dynamic'` ignores host sources and the beacon script carries no nonce, so it is a finding. Only enforced policies are judged; a `Content-Security-Policy-Report-Only` header is not.

The `headers` rule runs `checkSecurityHeaders` from `@dustinedwards/security-headers` (a git dependency, pinned by tag) on the page's response headers. The OWASP defaults and the test vectors live in that package alone: the watcher imports them, so a refresh of OWASP's data in the package changes this check with no second copy to keep in step. One finding per page lists up to 12 failed checks. A site that deliberately differs on a header is judged against the standard until the rule takes an override; add one when the first such site needs it.

## The document

`capsid/policy/live-checks.md` in the store, read each pass. No document, or one that does not parse, and no live check runs: nothing is fetched on a guess. An invalid document is itself one finding (`live-config-invalid`), naming the line. Only lines that begin `- site ` are rules; the rest is prose.

```
- site <namespace> beacon <path>
- site <namespace> nobeacon <path>
- site <namespace> headers <path>
- site <namespace> sha
```

- `<namespace>` is a site configured in the Portal's Settings (`ops_sites`). A rule for any other name is `live-config-unknown-site-<namespace>`, since it can never run.
- `<path>` starts with `/` and holds letters, digits and `. _ ~ / % -`. No query, no host: the check fetches the site's configured origin plus this path and nothing else.
- Up to 20 page rules and 6 sha rules, because each is a fetch or a GitHub read inside one pass.
- `sha` is for a site that deploys on merge and whose health route reports its sha in the standard format (docs/health-format.md). A site that ships by hand (dustinedwards deploys by dispatch) would be flagged on every merge, so it gets no `sha` line. `capsid` is refused: its own deploy is the `master head` check.
- Reads only. Every finding is a job posted by the watcher, deduplicated and remembered like the others.

## What it cannot see

- A beacon a page adds with inline script, or one Cloudflare adds in the browser, is not in the delivered HTML. Only a script tag naming the beacon host counts.
- It sees the HTML the Worker's request gets. Cloudflare injects the beacon at the edge on proxied sites, and whether a Worker's own subrequest receives the injected page was not verified from the build sandbox, which cannot reach the sites. The first activation is therefore supervised: read the first pass's `WATCHER_LIVE` log line and one page's result against a browser before trusting a `live-beacon-count` finding.
- Pages behind Cloudflare Access cannot be read as a signed-in user. That needs an Access service token (D6), which Dustin creates himself.

## Each pass logs what it read

A JSON log line with `event` `WATCHER_LIVE` and a `message` of `WATCHER_LIVE pages <read>/<expected> shas <read>/<expected> findings <n>`. No findings over zero pages read is not a clean bill: the count is the other half of the check.
