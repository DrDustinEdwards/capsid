# Bing Webmaster Tools

`capsid_inspect_repo` action `bing` (`src/bing-webmaster.ts`) reads Bing Webmaster Tools for a namespace's site. Bing's index also feeds ChatGPT search and Copilot, so this is where the site's standing in those shows.

## Reports

- `report: "queries"` (the default) and `report: "pages"`: clicks, impressions and average position per query or per page, summed over a window (default the 28 days ending 3 days ago) and sorted by clicks, top `row_limit` (1 to 1000, default 25). Bing keeps these in weekly buckets, so a window's edges move by a week.
- `report: "traffic"`: clicks and impressions per day over the window, with totals.
- `report: "inspect"` with `url`: one page's HTTP status, when Bing discovered it and last crawled it. The URL must be on the namespace's site.
- `report: "sitemaps"`: the submitted sitemaps and their status.
- `report: "crawl_issues"`: URLs Bing found redirected, broken, timed out or blocked.

## Which site

The caller names a namespace. Capsid lists the account's verified Bing sites and picks the one whose address matches the namespace's origin in `ops_sites` (the exact origin first, else the same host).

## The key

Bing's API key is one key for the whole Bing account, with no read-only scope. Capsid narrows it in code: the module calls only Bing's Get methods, from one fixed list, and never a submit, add or remove. The key goes in the query string, as Bing requires, and no request URL is logged or returned.

## Setup

1. Sign in at bing.com/webmasters. If a site is missing, add it with **Import from Google Search Console**.
2. Open **Settings** (the gear), then **API access**, then **API Key**, and generate the key.
3. Set it as the Worker secret `BING_WEBMASTER_API_KEY` (Cloudflare dashboard: Workers, capsid, Settings, Variables and Secrets, Add, type Secret).

Unset, the action fetches nothing and says the key is missing.
