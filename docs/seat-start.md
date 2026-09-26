# Seat-started sessions

The seat (a chat acting only through Capsid) can start a Claude Code session on GitHub's runners to work one queued job, with no laptop and no pasted prompt. The session runs on Dustin's Claude subscription through a long-lived OAuth token. The design, and the rulings behind it, are in Capsid at `capsid/research/design-seat-start.md`.

## How a session starts

1. The seat calls `jobs` action `start` with a job id. It is refused unless the caller is the seat (admin or `can_merge`), the switch is on, the job is queued and its signature verifies, its namespace is `capsid` or `dustinedwards` (`SEAT_START_NAMESPACES` in `src/seat-start.ts`), the namespace's primary repo is PUBLIC as GitHub reports it at that moment, no session for that repo is in flight, and the cap has room.
2. Capsid sends a `repository_dispatch` (`event_type: capsid-seat-start`, payload: the job id) to that repo through its GitHub App, and writes a `job-seat-started` audit row.
3. The repo's `.github/workflows/seat-session.yml` runs on that event and no other. It validates the job id, writes the Capsid connection for the runner key, and runs the Claude Code Action with `CLAUDE_CODE_OAUTH_TOKEN`.
4. The session claims the job with the runner key, works it on a branch, opens the pull request through Capsid's `open_pr`, and blocks the job for the seat to merge. It never merges and never deploys.

## The guards

- **The switch.** APP_KV `seat_start:enabled`. Only `on` enables; unset, any other value or an unreadable KV is off. It ships off. The admin sets it with `improve_run` action `seat_start` (value `on` or `off`) or from the console; both are audited. `improve_status` and the console header show it.
- **The cap.** APP_KV `seat_start:max_sessions`, 1 unless it reads `2`, set with the same action's `max_sessions`. A session is in flight while a runner holds a claimed job, or for 20 minutes after a start whose job is still queued. At most one session runs per repo; the workflow's `concurrency` group is the backstop.
- **Public repos only.** Checked against GitHub at every start. A repo that goes private is off for this feature, and a seat-started job carries nothing private, because Actions logs on a public repo are public.
- **Who can start one.** The workflow has no comment, issue or pull request trigger, so a stranger's comment or a fork pull request cannot start a session. Only a token with write access can send the dispatch. The Action rejects non-human actors unless listed, and lists exactly `capsid-repo-access`.
- **The runner.** One agent per namespace, `<ns>-runner`, of kind `session`: one namespace, read and write, no flags. It cannot merge, and auto-merge refuses its pull requests because they are not a driver's. A job a runner blocked resumes to the queue, since the runner's session ended when it blocked; the seat starts a new session for it.
- **Never deploy.** The runner's `GITHUB_TOKEN` has `contents: write` only; both default branches have a ruleset requiring a pull request; no Cloudflare secret is passed; deploy commands and `gh` are refused tools.

## Dustin's setup steps

Once the pull requests are merged, one at a time:

1. In a terminal logged in with the subscription, run `claude setup-token`. It prints a one-year token once and stores it nowhere.
2. In the repo on GitHub: Settings, Environments, New environment `seat`. Under deployment branches, allow the default branch only.
3. In that environment, add the secret `CLAUDE_CODE_OAUTH_TOKEN` with the token.
4. Mint the runner agent (admin): `agents` action `mint`, name `<ns>-runner`, kind `session`, the one namespace, grants read and write, no flags. Add its key to the same environment as `CAPSID_RUNNER_KEY`. The key is shown once.
5. Check that no `ANTHROPIC_API_KEY` secret or variable exists in the repo.
6. Turn the switch on (console, or `improve_run` action `seat_start`, value `on`).
7. The seat starts one small job. Afterwards, open the Anthropic billing and usage pages and confirm nothing was billed as API usage. The switch stays on only after that.

Repeat steps 2 to 5 for each repo.

## Pausing

- **Normal:** the switch, off. No new session starts; a running one finishes.
- **Backstop:** disable the `seat session` workflow in the repo's Actions tab. That stops anything, including a dispatch not sent through Capsid.
- **Emergency:** revoke the token in claude.ai settings (deleting the GitHub secret alone leaves it valid), and revoke the runner agents with `agents` action `revoke`.
