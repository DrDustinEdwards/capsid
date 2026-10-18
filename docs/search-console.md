# Search Console

`capsid_inspect_repo` action `search` (`src/search-console.ts`) reads Google Search Console for a namespace's site, so any session holding that namespace's read grant can see how the site does in Google. It is read-only: it asks Google only for the `webmasters.readonly` scope.

## Reports

- `report: "performance"` (the default): clicks, impressions, CTR and average position, grouped by up to three of `query`, `page`, `date`, `country`, `device` and `searchAppearance` (default `query`). The window defaults to the 28 days ending 3 days ago, because Google's numbers lag about two days. `query_contains` and `page_contains` narrow it; `row_limit` (1 to 1000, default 25) bounds it.
- `report: "inspect"` with `url`: one page's index status from URL Inspection (verdict, coverage, last crawl, Google's canonical beside the site's own). The URL must be on the namespace's site.
- `report: "sitemaps"`: the property's submitted sitemaps, with errors and warnings.

## Which property

The caller names a namespace, never a property. Capsid lists the properties the service account can read and picks the one covering the namespace's origin in `ops_sites`: a Domain property (`sc-domain:example.com`) for the host or a parent domain first, else the URL-prefix property for the origin. A namespace with no site row has no property.

## Setup

One Google service account reads every site.

1. In Google Cloud, create a project (or use one), and enable the **Google Search Console API** for it.
2. Under IAM and Admin, Service accounts, create a service account with no roles.
3. On that account's Keys tab, add a key of type JSON. The file downloads once.
4. In Search Console, for each site's property: Settings, Users and permissions, Add user, the service account's email, permission **Full** (Restricted hides some data; the read-only scope keeps it from changing anything).
5. Set the whole key file as the Worker secret `GSC_SERVICE_ACCOUNT_KEY` (Cloudflare dashboard: Workers, capsid, Settings, Variables and Secrets, Add, type Secret), then delete the downloaded file.

Unset, the action fetches nothing and says the key is missing. A property the account cannot read is refused with the email to add.
