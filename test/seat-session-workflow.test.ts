import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// scanner-rule: capsid/research/design-seat-start.md, the security properties of the seat-session workflow
//
// The workflow runs Claude Code on Dustin's subscription in a PUBLIC repo, so who can
// start it and what it may touch is decided by this file's text. These read it.

const TEXT = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "seat-session.yml"), "utf8");
// Comments stripped, so a comment naming a thing is not the thing.
const CODE = TEXT.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("the only trigger is the dispatch Capsid sends", () => {
  const on = /^on:\n([\s\S]*?)\n\S/m.exec(CODE);
  assert.ok(on, "no on: block parsed");
  const triggers = [...on[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(triggers, ["repository_dispatch"], "a trigger a stranger could cause was added");
  assert.match(on[1], /types: \[capsid-seat-start\]/);
});

test("one named bot, never a wildcard, and no API key anywhere", () => {
  assert.match(CODE, /allowed_bots: "capsid-repo-access"/);
  assert.doesNotMatch(CODE, /allowed_bots: "\*"/);
  assert.doesNotMatch(CODE, /allowed_non_write_users/);
  assert.doesNotMatch(CODE, /anthropic_api_key|ANTHROPIC_API_KEY/, "an API key would outrank the subscription token and bill the API");
  assert.match(CODE, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/);
});

test("the payload never reaches a script or the prompt unvalidated", () => {
  // The payload may appear once, as an env value, in the validating step.
  const payloadUses = [...CODE.matchAll(/github\.event\.client_payload/g)];
  assert.equal(payloadUses.length, 1, "the payload is read somewhere besides the validating step");
  assert.match(CODE, /JOB_ID: \$\{\{ github\.event\.client_payload\.job_id \}\}/);
  assert.match(CODE, /\^job_\[0-9a-f\]\{12\}\$/);
  // The prompt uses the validated output.
  assert.match(CODE, /steps\.job\.outputs\.id/);
});

test("secrets come from the seat environment, the transcript stays out of the public log, and deploy tools are refused", () => {
  assert.match(CODE, /^ {4}environment: seat$/m);
  assert.match(CODE, /show_full_output: false/);
  assert.match(CODE, /--disallowedTools "[^"]*Bash\(npx wrangler:\*\)[^"]*Bash\(gh:\*\)/);
  assert.doesNotMatch(CODE, /--allowedTools "[^"]*(wrangler|deploy|gh:)/);
  assert.match(CODE, /^permissions:\n {2}contents: write\n {2}pull-requests: read\n {2}issues: read$/m);
});
