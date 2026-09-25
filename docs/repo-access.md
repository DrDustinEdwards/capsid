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

`manage_pr` merges (squash by default) or closes a pull request, and deletes the head branch when it is safe. Both actions need `can_merge`, because both delete that branch. `delete_branch` refuses a branch with an open pull request; `force: true` lifts that refusal and so needs `can_merge` too.

`search_code` is a server-side tree walk (a recursive Git Trees listing, then bounded content scans), not GitHub's code search API, which returns empty results for private repositories under an App installation token. Use `path_prefix` to narrow large repos.
