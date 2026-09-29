import { getCookie, timingSafeEqual } from "./auth";
import { CONSOLE_PATH, consoleGate } from "./console";
import { CONSOLE_CSRF_COOKIE } from "./console-auth";
import { escapeHtml } from "./html";
import type { Env } from "./env";
import { describeAction, performAction, type ActionParams } from "./portal-actions";
import { readBoundedText } from "./improve-scorer";

// The console's controls. Each is the admin session, a CSRF token, a confirm step,
// then the shared mutator the MCP tool calls, then an audit row naming the person who
// clicked. The mutator dispatch and the audit row are performAction in
// src/portal-actions.ts, which the Portal's endpoints call too; nothing here
// reimplements a transition.
//
// No merge (it can start a CI deploy, so it stays behind can_merge) and no mint (a
// mint hands out a key). test/console-actions.test.ts asserts both absences.
//
// The confirm is a second request: the first POST renders what will happen and
// changes nothing; the second, with the same CSRF, performs it.

export const CONSOLE_ACTIONS = ["pause", "unpause", "mode", "seat_start", "resume_job", "fail_job", "release_job", "revoke_agent"] as const;
export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

function isConsoleAction(value: string): value is ConsoleAction {
  return (CONSOLE_ACTIONS as readonly string[]).includes(value);
}

// Same cap as the consent form, applied at the stream before parsing.
const ACTION_FORM_MAX_BYTES = 65_536;

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

// The form as the dispatch reads it. The first value of a repeated field wins, as
// URLSearchParams.get does.
function paramsOf(form: URLSearchParams): ActionParams {
  const params: ActionParams = {};
  for (const [key, value] of form) if (!Object.hasOwn(params, key)) params[key] = value;
  return params;
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
<p>${escapeHtml(describeAction(action, paramsOf(form)))}</p>
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
    return textResponse("csrf validation failed: reload Capsid Portal and try again.", 403);
  }

  if (form.get("confirm") !== "yes") return confirmPage(action, form, csrfField);

  const result = await performAction(env, gate.user.email, now, action, paramsOf(form));
  if (!result.ok) return textResponse(result.refusal, 400);
  if (result.warning) {
    // The action happened; only the console's own audit row failed, so no 400.
    return new Response(result.warning, {
      status: 303,
      headers: {
        Location: CONSOLE_PATH,
        "Content-Type": "text/plain;charset=utf-8",
        // A header value must be printable Latin-1; the error text is not guaranteed to be.
        "X-Capsid-Warning": result.warning.replace(/[^\x20-\x7e]+/g, " "),
      },
    });
  }

  // POST then redirect, so a reload does not repeat the action.
  return new Response(null, { status: 303, headers: { Location: CONSOLE_PATH } });
}
