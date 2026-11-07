# Reliability target

Status: proposed (2026-11-07). The target and the budget are numbers to measure against. Nothing enforces the pause rule yet; see "What stays open".

## The target

For each site, 99.9% of the requests a visitor makes are answered without a 5xx, measured over a rolling 28 days. The budget is the other 0.1%: 1,000 failed requests per million, about 40 minutes of total failure in a month.

- **What counts:** a 5xx the edge answered a visitor, as `capsid_inspect_repo` action `traffic` report `server_errors` reads it.
- **What does not:** the 501 a site gives on purpose to Carrel's conformance check, and traffic that is not a visitor.
- **Why 99.9%:** it sits under Cloudflare's own 99.99% monthly objective for Workers (https://www.cloudflare.com/workers-service-level-agreement), which a site cannot honestly beat, and the first week of measurement is at or near 100% (7 days of the watcher's half-hour health checks: ten sites with no failed check, Foxing with one). A target is meant to be set from measured performance over about four weeks and rounded down (https://sre.google/workbook/implementing-slos/). Review it after one full 28-day window of visitor-only counts, and move it if the data says so.

## What the budget is for

The watcher's alert (more than 1% errors over 100 requests in an hour, `ERROR_RATE_THRESHOLD`) says a site is bad now. The budget says how much bad the month can hold. One blip inside the budget needs no action; a run of them that spends it does.

## When a site spends its budget

Following Google's example error budget policy (https://sre.google/workbook/error-budget-policy/):

1. Changes to that site stop except security fixes and rollbacks, until the 28-day rate is back inside the target.
2. One incident that spends more than 20% of the budget gets a short written postmortem with one concrete fix.
3. Visitor-visible decisions stay with Dustin. This policy decides only when merging stops, not what ships.

The exceptions follow Google's: a Cloudflare-wide outage, load tests and other planned traffic that is not a visitor do not spend the budget.

## What stays open

- The 28-day baseline from visitor-only counts. The first measurement used Cloudflare's raw status counts, which include intended 501s and bots, so it overstates errors (julieedwards.info read 10% raw, almost all 501s). The visitor-only report covers 7 days at most; the target needs a stored 28-day series per site.
- The pause itself is a change to auto-merge (`docs/policy/auto-merge.md`, a refused path), so it waits for the seat, with the watcher code that computes the 28-day rate.
- Germomics returned bursts of 503s on `.data` requests until 2026-11-06. They came from one automated visitor at fixed hours. If they are counted, they decide whether germomics met the target that week.
