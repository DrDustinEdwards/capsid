# Session hooks

Claude Code can post each hook event to a URL. Capsid receives eight of them at `POST /ops/hooks` (`src/ops-hooks.ts`) and keeps a summary of every session: the job it works, its last event, whether it is waiting on a person, its last failure and whether it has ended. Capsid Portal shows these as Live sessions on the Queue view, and a session that stopped on a failure a person must fix, or that has waited on input for more than ten minutes, as an incident.

## What is kept, and what never is

Only named fields are read off a hook body. Everything else in it is ignored, so it cannot reach D1.

| Event | Kept |
| --- | --- |
| `SessionStart` | `source`, `model`, `permission_mode` |
| `Notification` | `notification_type`, and the `title` and `message` capped at 120 and 300 characters |
| `StopFailure` | `error`, and `last_assistant_message` capped at 300 characters, because on this event it is the API error string |
| `ConfigChange` | `source`, and `file_path` capped at 300 characters |
| `SessionEnd` | `reason` |
| `Stop` | the event and its time |
| `PostToolUse` | `tool_name`; for `Edit`, `Write` and `MultiEdit` the `file_path` capped at 300 characters; for `Bash` the first word of the command, reduced to its basename, and the exit code `0` |
| `PostToolUseFailure` | the same, and for `Bash` the exit code from an `Exit code N` first line of `error`; `interrupted` when `is_interrupt` is true |

The tool events are the two that fire after a tool ran. `PreToolUse` is not taken: it would double the rows and fires before the exit code exists. A tool name outside `[A-Za-z][A-Za-z0-9_-]{0,127}` is stored as `unknown`, so the call is still counted. A `Bash` command whose first word is not a plain program name (an env assignment such as `TOKEN=abc npm test`) keeps no command. Tool rows are shared with the anomaly rules: an agent's busiest tool-call hour over three times its busiest baseline hour, and at least 600 calls, is a watcher finding (`src/anomaly.ts`, `toolRateFindings`).

Never kept: a prompt, a response, `last_assistant_message` on any other event, tool input or output beyond the fields named above, `tool_use_id`, `duration_ms`, the transcript path or its contents, the session title, the working directory. A test plants content in each of those fields for all eight events and fails if any of it reaches a D1 statement (`test/ops-hooks.test.ts`).

A session waits on a person after a `Notification` of type `agent_needs_input`, `permission_prompt`, `idle_prompt`, `elicitation_dialog` or `elicitation_url_dialog`. A later event of any other kind, or a `Notification` of type `agent_completed`, clears it. A `StopFailure` records its error until a `Stop` shows a turn ending normally. The errors shown as incidents are `rate_limit`, `billing_error`, `authentication_failed`, `account_on_hold` and `oauth_org_not_allowed`. Incidents are decided when the feed is read, and no job is posted for one.

Hook events are kept 30 days. Each call prunes a bounded batch of older rows.

## Who may post

The request carries the session's own key as `Authorization: Bearer <key>`. Capsid resolves it the way `/ops/mcp` does. A missing, unknown or revoked key gets 401. A key that resolves but is not a driver or the admin gets 403, and so does any key without the write grant. The events bind to a job:

- a driver key: the one job it holds claimed, or no job when it holds none or more than one

A session keeps the job it was first bound to. Only the key that first reported a session can add to it; another key gets 409. The body is capped at 64KB (413 over that). An event other than the eight gets 400. A recorded event gets 200 with an empty body, so Claude Code counts the hook a success and reads no decision from it. Any refusal is a non-blocking error in Claude Code: the session carries on.

## Settings for a driver repo

In the driver repo's `.claude/settings.json`. The key is read from the environment and never written into the file. Set `CAPSID_HOOK_KEY` in the shell that starts the session, to the same driver key the session's Capsid connection uses.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "Notification": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "StopFailure": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "ConfigChange": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "http", "url": "https://mcp.dustinedwards.info/ops/hooks", "headers": { "Authorization": "Bearer $CAPSID_HOOK_KEY" }, "allowedEnvVars": ["CAPSID_HOOK_KEY"], "timeout": 5 }] }]
  },
  "allowedHttpHookUrls": ["https://mcp.dustinedwards.info/ops/hooks"]
}
```

`allowedEnvVars` is what lets `$CAPSID_HOOK_KEY` be interpolated into the header; Claude Code interpolates no variable that is not listed. `allowedHttpHookUrls` limits HTTP hooks to the Worker's receiver. It is an array, and arrays merge across settings files.

## Settings for Dustin's machine

The same block in `~/.claude/settings.json` reports every session started on the machine, whichever repo it is in. Export `CAPSID_HOOK_KEY` in the shell profile to the driver key for the work at hand. A session started without it sends no usable key, gets 401, and shows a non-blocking hook error; nothing is recorded for it. Put the block in one place or the other, not both: in both, each event is posted twice and recorded twice.

