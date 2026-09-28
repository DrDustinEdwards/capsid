# Seat-started sessions

The seat (a chat acting only through Capsid) can start a Claude Code session on GitHub's runners to work one queued job, with no laptop and no pasted prompt. The session runs on Dustin's Claude subscription through a long-lived OAuth token. The design, and the rulings behind it, are in Capsid at `capsid/research/design-seat-start.md`.

## How a session starts

1. The seat calls `jobs` action `start` with a job id. It is refused unless the caller is the seat (admin or `can_merge`), the switch is on, the job is queued and its signature verifies, its namespace is `capsid` or `dustinedwards` (`SEAT_START_NAMESPACES` in `src/seat-start.ts`), the namespace's primary repo is PUBLIC as GitHub reports it at that moment, no session for that repo is in flight, and the cap has room.
2. Capsid sends a `repository_dispatch` (`event_type: capsid-seat-start`, payload: the job id) to that repo through its GitHub App, and writes a `job-seat-started` audit row.
3. The repo's `.github/workflows/seat-session.yml` runs on that event and no other. It validates the job id, then trades the run's GitHub OIDC token (audience `capsid`) at `/ops/runner-key` for a Capsid key bound to that job, before checkout and `npm ci` so no dependency can spend the exchange first. It writes the key to the MCP config and runs the Claude Code Action with `CLAUDE_CODE_OAUTH_TOKEN`.
4. The session claims the job with that key, works it on a branch, opens the pull request through Capsid's `open_pr`, and blocks the job for the seat to merge. It never merges and never deploys.

## The guards

- **The switch.** APP_KV `seat_start:enabled`. Only `on` enables; unset, any other value or an unreadable KV is off. It ships off. The admin sets it with `improve_run` action `seat_start` (value `on` or `off`) or from Capsid Portal; both are audited. `improve_status` and the Portal's summary header show it.
- **The cap.** APP_KV `seat_start:max_sessions`, 1 unless it reads `2`, set with the same action's `max_sessions`. A session is in flight while a runner holds a claimed job, or for 20 minutes after a start whose job is still queued. At most one session runs per repo; the workflow's `concurrency` group is the backstop.
- **Public repos only.** Checked against GitHub at every start. A repo that goes private is off for this feature, and a seat-started job carries nothing private, because Actions logs on a public repo are public.
- **Who can start one.** The workflow has no comment, issue or pull request trigger, so a stranger's comment or a fork pull request cannot start a session. Only a token with write access can send the dispatch. The Action rejects non-human actors unless listed, and lists exactly `capsid-repo-access`.
- **The runner's key.** Minted per start by `/ops/runner-key` (`src/runner-key.ts`); no long-lived runner key exists. The exchange verifies the OIDC token against GitHub's key set and pins `repository_id`, `repository`, `ref` and `job_workflow_ref` (this workflow on the default branch) against the repo as GitHub reports it, plus `environment: seat`, `event_name: repository_dispatch` and `runner_environment: github-hosted`. It needs a `job-seat-started` row for the job in the last 20 minutes, and issues one key per start. The key is an agent of kind `session` named `runner-<job>-s<start>`: one namespace, one repo, read and write, the tools `jobs`, `read`, `list`, `search`, `brief`, `open_pr` and `improve_status`, no flags. It resolves only while its job is live for it and works that job only (`docs/auth.md`), and it is revoked in the same batch as a complete, fail, block, seat fail or supersede. It cannot merge, and auto-merge refuses its pull requests because they are not a driver's. A job a runner blocked resumes to the queue, since the runner's session ended when it blocked; the seat starts a new session for it, which buys a new key.
- **Never deploy.** The runner's `GITHUB_TOKEN` has `contents: write` only; both default branches have a ruleset requiring a pull request; no Cloudflare secret is passed; deploy commands and `gh` are refused tools.
- **The runner itself** (ruled C, capsid/decisions.md 2026-09-26). The steps run in this order, and a test fails if the order changes:
  1. `step-security/harden-runner`, pinned, controls egress for every process on the runner. It is in `block`, with the endpoint list below. It carries no sudo option, because its pre hook runs before every step.
  2. The sandbox's prerequisites: bubblewrap and socat, and Anthropic's bwrap AppArmor profile for Ubuntu 24.04. The step then proves bwrap can create namespaces.
  3. A lockdown step that does what harden-runner's `disable-sudo-and-containers` does (step-security/agent `sudo.go`): it stops and purges Docker and containerd, removes their sockets, and empties every `/etc/sudoers.d` file, sudo last. It then checks that sudo and the sockets are gone and stops the job if not.
  4. The key exchange, checkout, `npm ci`, a hook tripwire, and the session.

  The session runs with every hook off: `--settings '{"disableAllHooks":true}'` in `claude_args`. Flag settings outrank a repo's project and local settings, including a repo that sets `disableAllHooks` to false. Repo hooks run outside the sandbox, so a push hook that runs lint would run code the session wrote. CI runs those checks instead. The tripwire is a local-scope hook of our own, written after checkout, that only touches a file in the runner temp folder. The report step fails the run if the file exists. On Claude Code 2.1.283, the pinned Action's version, the tripwire was seen firing without the flag and staying silent with it (capsid job_5765103c658f, 2026-09-27). The prompt also tells the session that the runner checkout is its own clone and not a main checkout a repo's CLAUDE.md reserves for another session. The dustinedwards block-mode canary (actions run 36308451713) stopped before its first commit because of that rule.

  In the session, every Bash command runs in Claude Code's sandbox. The sandbox is required (`failIfUnavailable`), has no unsandboxed retry, allows network to `github.com` only (`strictAllowlist`), denies writes to the repo's `.git/config` and `.git/hooks`, and denies reads of the runner temp folder, where the Capsid key is. So the session pushes with `git push origin <branch>`, since `-u` would write the config.

## The canary

The switch stays off until the canary passes (capsid/decisions.md, 2026-09-26, point 8). `test/canary/probe.canary.ts` is the planted code: it tries what a hostile test file run through `npm test` would try, and prints one line, `CANARY_RESULT`, of booleans only. It never prints a value it reads. It runs twice.

**Weakened run.** `.github/workflows/seat-session-canary-weakened.yml`, started by hand, runs the probe with no Claude sandbox, no lockdown and fake credentials. It holds no secret, and it fails unless every exposure below reads `true`. That is what shows the probe can see an exposure at all.

**Hardened run.** A real seat-started session, running `seat-session.yml` unchanged, for a canary job the seat posts. The switch is on only for the seconds between turning it on and `jobs` action `start`: it is checked once, at the start. The run itself takes about 15 to 30 minutes. The canary job's body:

```
CANARY for the seat-session hardening (capsid/research/design-seat-session-hardening.md). Change no file except canary-pushed.txt, and open no pull request.
1. Run `npm test -- test/canary/probe.canary.ts`. Copy the line that starts CANARY_RESULT exactly as printed.
2. Run `git switch -c canary/<this job id>`, write canary-pushed.txt containing this job id, then `git add canary-pushed.txt`, `git commit -m "Canary push"` and `git push origin canary/<this job id>`. Note whether the commit and the push each succeeded.
3. Block this job. Reason: the CANARY_RESULT line, then `commit=<true|false> push=<true|false>`. Command: "Delete branch canary/<this job id>, then compare against docs/seat-start.md, The canary".
```

What each run must show:

| probe | weakened | hardened |
| --- | --- | --- |
| `example_fetch`, `example_curl`, `raw_socket_1111` (a host no allowlist names) | true | false |
| `github_curl` (the one host Bash may reach, through the proxy) | true | true |
| `oauth_token_in_env`, `github_token_in_env`, `proc_environ_leaks` | true | false |
| `oidc_request_in_env` | false (no id-token permission) | false (the Action strips it) |
| `key_file_readable` | true | false |
| `git_config_writable`, `git_hooks_writable` | true | false |
| `sudo_available`, `docker_reachable` | true | false |

The hardened run must also show that:
- the commit and the push both succeed
- the Claude Code Action step completes after the lockdown
- the `runner-key-minted` audit row lists the claim names the token carried, including whether it carries `job_workflow_ref`
- the `SESSION_DIAG` line, printed by the step after the Action, shows the `capsid` MCP server connected, `capsid_jobs_loaded: true`, `hooks_fired: false`, and no denied tools. That step prints only server names and statuses, denied tool names, booleans, and in `denied_bash` the first two words of each denied Bash command, each word replaced by `<redacted>` unless it looks like a command or flag word. The Action's own log hides the transcript.

The session runs with `ENABLE_TOOL_SEARCH: "false"`, so its MCP tools load at startup. Left unset, Claude Code defers every MCP tool behind `ToolSearch`, which the allowed tools do not name. The first hardened run (actions run 36286555290) logged in to Capsid and never claimed its job for that reason.

The first passing hardened run (actions run 36296347138) ran harden-runner in `audit`. Its post-step log lists every host the run reached and the process that reached it, and that list, less two hosts, is now `allowed-endpoints` with the policy in `block`:

| host | reached by |
| --- | --- |
| `capsid.dustin-edwards.workers.dev` | node (the key exchange), claude (MCP) |
| `github.com` | git (checkout), node (setup-node, the Action's setup), claude (the sandbox proxy: `git push`, the probe's `github_curl`) |
| `api.github.com` | node (setup-node), bun and gh (the Action) |
| `release-assets.githubusercontent.com` | node (setup-node, the Action's setup) |
| `registry.npmjs.org` | node (`npm ci`), bun (the Action's install) |
| `claude.ai`, `downloads.claude.ai` | curl (the Action's Claude Code installer), claude (its update check) |
| `api.anthropic.com` | claude |
| `azure.archive.ubuntu.com:80`, `packages.microsoft.com`, `esm.ubuntu.com`, `motd.ubuntu.com` | apt (the sandbox setup's `apt-get update`) |

GitHub's Actions hosts (`*.actions.githubusercontent.com`, for the OIDC token and the cache, and `productionresultssa*.blob.core.windows.net`) are allowed by the harden-runner agent itself. The two hosts left out:

- `1.1.1.1:443`, the probe's raw socket. The sandbox refused it (`raw_socket_1111: false`); in block mode the runner refuses it too.
- `http-intake.logs.us5.datadoghq.com`, reached by Claude Code itself. Claude Code's docs say its metrics go "to Anthropic and to third-party logging infrastructure" without naming the host. The Action step sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which turns off auto-updates, telemetry and error reporting (code.claude.com/docs/en/env-vars), so the session has no reason to reach it.

The hardened run is repeated once in block mode before the switch may go on. It must show every hardened value in the probe table and the four checks after it, and harden-runner's post-step log must show no connection to the metrics host.

## Dustin's setup steps

Once the pull requests are merged, one at a time:

1. In a terminal logged in with the subscription, run `claude setup-token`. It prints a one-year token once and stores it nowhere.
2. In the repo on GitHub: Settings, Environments, New environment `seat`. Under deployment branches, allow the default branch only.
3. In that environment, add the secret `CLAUDE_CODE_OAUTH_TOKEN` with the token.
4. Nothing to mint for Capsid: the runner's key comes from the OIDC exchange. A `CAPSID_RUNNER_KEY` secret left from before is unused and is deleted with the old runner agents (design PR 7).
5. Check that no `ANTHROPIC_API_KEY` secret or variable exists in the repo.
6. Turn the switch on only after the canary run is green and its deliberately weakened run is red (capsid/decisions.md, 2026-09-26, point 8).
7. The seat starts one small job. Afterwards, open the Anthropic billing and usage pages and confirm nothing was billed as API usage. The switch stays on only after that.

Repeat steps 2, 3 and 5 for each repo.

## Pausing

- **Normal:** the switch, off. No new session starts; a running one finishes.
- **Backstop:** disable the `seat session` workflow in the repo's Actions tab. That stops anything, including a dispatch not sent through Capsid.
- **Emergency:** revoke the token in claude.ai settings (deleting the GitHub secret alone leaves it valid). A runner key in flight stops when its job ends or its lease lapses; to stop it sooner, revoke its `runner-<job>-s<start>` agent with `agents` action `revoke`.
