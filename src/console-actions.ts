import { adminAgent } from "./agents";
import { revokeAgent } from "./agents-admin";
import { getCookie, timingSafeEqual } from "./auth";
import { CONSOLE_PATH, consoleGate } from "./console";
import { CONSOLE_CSRF_COOKIE } from "./console-auth";
import { escapeHtml } from "./html";
import type { Env } from "./env";
import { improveControl } from "./improve-run";
import { adminFailJob, releaseJob, resumeJob } from "./jobs";
import { readBoundedText } from "./improve-scorer";
import { auditStatement } from "./store-guards";

// The console's controls. Each is the admin session, a CSRF token, a confirm step,
// then the shared mutator the MCP tool calls, then an audit row naming the person who
// clicked. Nothing here reimplements a transition.
//
// No merge (it can start a CI deploy, so it stays behind can_merge) and no mint (a
// mint hands out a key). test/console-actions.test.ts asserts both absences.
//
// The confirm is a second request: the first POST renders what will happen and
// changes nothing; the second, with the same CSRF, performs it.

const CONSOLE_ACTIONS = ["pause", "unpause", "mode", "resume_job", "fail_job", "release_job", "revoke_agent"] as const;
export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

function isConsoleAction(value: string): value is ConsoleAction {
  return (CONSOLE_ACTIONS as readonly string[]).includes(value);
}

// Same cap as the consent form, applied at the stream before parsing.
const ACTION_FORM_MAX_BYTES = 65_536;

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

function required(form: URLSearchParams, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// What each action is about to do, naming the target, for the confirm step.
function describe(action: ConsoleAction, form: URLSearchParams): string {
  const ns = form.get("namespace") ?? "";
  const id = form.get("id") ?? "";
  switch (action) {
    case "pause":
      return `Pause the improve loop for ${ns}. It stays paused until somebody unpauses it: the pause key has no expiry, deliberately.`;
    case "unpause":
      return `Unpause ${ns}. The loop will open a run for it on the next opener.`;
    case "mode":
      return `Set the improve mode to ${form.get("value") ?? ""} for every namespace.`;
    case "resume_job":
      return `Resume blocked job ${id}. The job moves back to claimed under the driver that blocked it, with a fresh lease, and that driver continues it. It does not move to you. If that driver already holds another claimed job, or the job was blocked by a shared identity such as your own admin session, it goes back to the queue with your approval instead, and the next free session claims it.`;
    case "release_job":
      return `Release job ${id} back to the queue. Whoever holds it loses the claim, the next free session claims it, and no outcome is recorded against the holder.`;
    case "fail_job":
      return `Mark job ${id} failed. This is the seat stepping in on a job it does not hold, and it is recorded as such.`;
    case "revoke_agent":
      return `Revoke the agent ${form.get("name") ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
  }
}

function confirmPage(action: ConsoleAction, form: URLSearchParams, csrf: string): Response {
  const carried = [...form.entries()]
    .filter(([k]) => k !== "confirm" && k !== "csrf")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm ${escapeHtml(action)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.6 system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; }
.card { border: 1px solid currentColor; border-radius: 8px; padding: 1.5rem; }
button { font: inherit; padding: 0.5rem 1.2rem; border-radius: 6px; cursor: pointer; }
a { display: inline-block; margin-left: 1rem; }
</style>
</head>
<body>
<div class="card">
<h1>Confirm: ${escapeHtml(action)}</h1>
<p>${escapeHtml(describe(action, form))}</p>
<form method="post" action="${CONSOLE_PATH}">
${carried}
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="confirm" value="yes">
<button type="submit">Yes, do it</button>
<a href="${CONSOLE_PATH}">Cancel</a>
</form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

// The click's own audit row, naming the admin. The shared mutators' rows do not say
// who asked (improveControl records a pause as `improve-loop`).
async function auditClick(env: Env, actor: string, action: ConsoleAction, namespace: string | null, params: unknown) {
  await env.DB.batch([auditStatement(env.DB, actor, `console-${action}`, namespace, null, params)]);
}

export async function handleConsoleAction(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, CONSOLE_PATH);
  if (!gate.ok) return gate.response;

  // Bounded at the stream, before the parse, on a path that mutates.
  const bounded = await readBoundedText(request, ACTION_FORM_MAX_BYTES);
  if (!bounded.ok) return new Response(null, { status: 413 });
  const form = new URLSearchParams(bounded.text);

  const action = form.get("action") ?? "";
  if (!isConsoleAction(action)) {
    return textResponse(
      `unknown console action '${action}'. The console does: ${CONSOLE_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them.`,
      400
    );
  }

  // CSRF before anything else, including the confirmation page, which would carry a
  // valid token forward for a forged request.
  const csrfField = form.get("csrf");
  const csrfCookie = getCookie(request, CONSOLE_CSRF_COOKIE);
  if (!csrfField || !csrfCookie || !timingSafeEqual(csrfCookie, csrfField)) {
    return textResponse("csrf validation failed: reload the console and try again.", 403);
  }

  if (form.get("confirm") !== "yes") return confirmPage(action, form, csrfField);

  const actor = `github:${gate.user.login}`;
  const agent = adminAgent(gate.user.login);
  // Set once the mutator succeeds, so the catch knows whether the action happened.
  let committed = false;
  try {
    switch (action) {
      case "pause":
      case "unpause": {
        const namespace = required(form, "namespace");
        if (!namespace) return textResponse(`${action} needs a namespace.`, 400);
        const reason = form.get("reason")?.trim() || undefined;
        const result = await improveControl(env, action, { namespace, reason });
        committed = true;
        await auditClick(env, actor, action, namespace, result);
        break;
      }
      case "mode": {
        const value = required(form, "value");
        if (!value) return textResponse("mode needs a value.", 400);
        const result = await improveControl(env, "mode", { value });
        committed = true;
        await auditClick(env, actor, action, null, result);
        break;
      }
      case "resume_job":
      case "release_job":
      case "fail_job": {
        const id = required(form, "id");
        const reason = required(form, "reason");
        if (!id) return textResponse(`${action} needs a job id.`, 400);
        if (!reason) {
          return textResponse(
            action === "resume_job"
              ? "resume needs a reason: what you approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen."
              : action === "release_job"
                ? "release needs a reason: why the holder is not coming back."
                : "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.",
            400
          );
        }
        const result =
          action === "resume_job"
            ? await resumeJob(env, agent, now, id, reason)
            : action === "release_job"
              ? await releaseJob(env, agent, now, id, reason)
              : await adminFailJob(env, agent, now, id, reason);
        if (!result.ok) return textResponse(result.refusal ?? `${action} was refused.`, 400);
        committed = true;
        await auditClick(env, actor, action, result.job?.namespace ?? null, { id, reason });
        break;
      }
      case "revoke_agent": {
        const name = required(form, "name");
        if (!name) return textResponse("revoke_agent needs an agent name.", 400);
        const result = await revokeAgent(env.DB, actor, name);
        if (!result.ok) return textResponse(result.refusal ?? `revoking ${name} was refused.`, 400);
        committed = true;
        await auditClick(env, actor, action, null, { name });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (committed) {
      // The action happened; only the console's own audit row failed, so no 400.
      const warning = `${action} completed, but the console audit row naming ${actor} was not written: ${message}`;
      console.error(warning);
      return new Response(warning, {
        status: 303,
        headers: {
          Location: CONSOLE_PATH,
          "Content-Type": "text/plain;charset=utf-8",
          // A header value must be printable Latin-1; the error text is not guaranteed to be.
          "X-Capsid-Warning": warning.replace(/[^\x20-\x7e]+/g, " "),
        },
      });
    }
    // improveControl throws on a bad value, with a message that says so.
    return textResponse(message, 400);
  }

  // POST then redirect, so a reload does not repeat the action.
  return new Response(null, { status: 303, headers: { Location: CONSOLE_PATH } });
}
