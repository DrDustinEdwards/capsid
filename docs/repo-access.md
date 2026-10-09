# Repo access

Capsid reaches mapped repositories through a dedicated GitHub App. The Worker mints a short-lived installation token (an RS256 JWT signed with Web Crypto, exchanged for an installation access token, cached in KV), so no long-lived token is stored. Repos resolve from the `namespaces` table.

A namespace can map to several repos, each with a label (for example `primary` and `legacy`). Every repo tool takes an optional `repo` parameter, a label or a mapped `owner/name`, defaulting to `primary`. An unmapped repo is rejected, so the namespace mapping is the authorization boundary.

- **Read**: `list_repo_tree`, `read_repo_file`, `search_code`, `repo_refs`, `repo_history`, `ci_status`
- **Write**: `write_repo_file`, `create_branch`, `delete_branch`, `open_pr`, `delete_repo_file`, `manage_pr`, `ci_dispatch`

`write_repo_file` defaults to `mode: "pr"` (commit to a new branch, open a pull request). `mode: "direct"` commits to the default branch and needs `can_direct_write`. `delete_repo_file` takes the same modes.

In `mode: "pr"` a caller may name the work branch with `branch`. Two cases are refused before anything is committed:

- `branch` is the repo's default branch. The commit would land there without a pull request; that is what `mode: "direct"` is for.
- `branch` already has an open pull request and the call does not pass `pr` with that pull request's number. The refusal names the pull request. With `pr` set to it, the commit lands on that branch and no second pull request is opened; the result reports the existing one with `existing: true`. A `pr` that is not the branch's open pull request is refused, and so is `pr` in `mode: "direct"` or without `branch`.

The open-pull-request check is one uncached GitHub call. If it fails, the write is refused rather than treated as "no open pull request".

`manage_pr` merges (squash by default) or closes a pull request, and deletes the head branch when it is safe. Both actions need `can_merge`, because both delete that branch. `delete_branch` refuses a branch with an open pull request; `force: true` lifts that refusal and so needs `can_merge` too. `delete_branch` with `merged: true` (in place of `branch`) prunes the branches whose latest pull request merged and whose tip is the commit it merged from, so work pushed after a merge is kept: it previews by default and deletes only with `confirm: true`, at most 40 a call, and it never lifts a refusal.

## CI status and logs

`ci_status` lists a repo's recent workflow runs, narrowed by `ref` (a branch or a head sha) or `run_id`. For the newest failed run it names the failing jobs and steps and returns the failing step's log.

With `run_id` it can also drill into any run, failed or not:

- `jobs: true` returns every job of the run's latest attempt with its steps, their conclusions and their start and end times. One page of at most 100 jobs is read; a run with more says so in `jobs_truncated`.
- `job` (a name or a numeric id) returns that one job and its steps.
- `job` with `step` (a name or a step number) also returns that step's log.

These return the run and its jobs in place of the run list. A step's log is cut the same way as the failed step's: by the step's start and end times, since every log line carries a timestamp and a step's name appears nowhere in its own output. It is capped at 64KB from its end. A step with no usable times (still running, or skipped) falls back to the end of the whole job log, and `log_region` says so.

A name two jobs or two steps share is refused with the ids or numbers that tell them apart. So are `step` without `job`, `job` or `jobs` without `run_id`, and `jobs` together with `job`.

**Who gets a log.** Run and job metadata is open to read-only keys. Every log, the failed-run tail and a step's log alike, is returned only to a caller with the write grant on the namespace (a namespace's driver, or the admin). A read-only caller gets a note that the log was withheld, and the log is never fetched.

**Redaction.** Every log text `ci_status` returns, and every GitHub error body it echoes, passes through `src/redact.ts` first. It replaces each secret-shaped value with `[REDACTED:<kind>]` and counts them in `log_redactions`: GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Authorization header values and Bearer or Basic credentials, AWS access key ids, private key blocks (an unterminated block to the end of the text), JWTs, Slack tokens and webhook URLs, assignments to a secret-named key (`API_TOKEN=...`, `password: ...`, `"client_secret": "..."`, `?access_token=...`), and long random-looking runs just after a word such as secret, token, key or password. Redaction runs before the 64KB cut, so a cut cannot split a secret into a half no pattern matches. It errs toward over-redacting. GitHub masks only the secrets it was given, as `***`; this covers what a step printed by accident.

`search_code` is a server-side tree walk (a recursive Git Trees listing, then bounded content scans), not GitHub's code search API, which returns empty results for private repositories under an App installation token. Use `path_prefix` to narrow large repos.
