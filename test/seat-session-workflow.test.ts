import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // The whole block, up to the blank line after it, so a permission added below the
  // last one is caught rather than matched past.
  assert.match(CODE, /^permissions:\n {2}contents: write\n {2}pull-requests: read\n {2}issues: read\n {2}id-token: write\n\n/m);
});

// capsid/research/design-seat-session-hardening.md, PR 3: the runner's Capsid key is
// bought per run with its OIDC token, before any dependency code can ask for one.
test("the Capsid key comes from the OIDC exchange, before checkout, and no long-lived runner key is read", () => {
  assert.doesNotMatch(CODE, /CAPSID_RUNNER_KEY/, "a long-lived runner key is still read");
  const exchange = CODE.indexOf("name: Exchange this run's OIDC token");
  const validate = CODE.indexOf("name: Validate the job id");
  const checkout = CODE.indexOf("actions/checkout@");
  const install = CODE.indexOf("run: npm ci");
  assert.ok(exchange > validate && validate >= 0, "the exchange does not follow the job id check");
  assert.ok(exchange < checkout && exchange < install, "the exchange runs after checkout or npm ci, where a dependency could spend it first");
  const step = CODE.slice(exchange, checkout);
  assert.match(step, /JOB_ID: \$\{\{ steps\.job\.outputs\.id \}\}/);
  assert.match(step, /"&audience=capsid"/);
  assert.match(step, /https:\/\/mcp\.dustinedwards\.info\/ops\/runner-key/);
  assert.match(step, /::add-mask::" \+ key/);
  assert.match(step, /capsid-mcp\.json/);
});

// An allowed interpreter runs any program, which reaches the network and the
// environment, so it would make the refused list above decorative.
const INTERPRETERS = ["node", "bash", "sh", "zsh", "dash", "python", "python3", "perl", "ruby", "deno", "bun", "pwsh", "powershell", "env", "xargs", "eval", "exec"];

test("no allowed Bash pattern is an unbounded interpreter", () => {
  const allowed = /--allowedTools "([^"]*)"/.exec(CODE);
  assert.ok(allowed, "no --allowedTools parsed");
  const entries = allowed[1].split(",").map((e) => e.trim());
  const bash = entries.filter((e) => /^Bash(\(|$)/.test(e));
  // The scan must see the npm entries it exists to sit beside, or it passes vacuously.
  assert.ok(bash.includes("Bash(npm test:*)") && bash.includes("Bash(npm run check:*)"), `parsed Bash entries: ${bash.join(" ")}`);
  for (const entry of bash) {
    const command = /^Bash\((.*)\)$/.exec(entry)?.[1];
    assert.ok(command && command !== "*" && command !== ":*", `${entry} allows every command`);
    const [first, second] = command.replace(/:\*$/, "").split(/\s+/);
    assert.ok(!INTERPRETERS.includes(first), `${entry} allows an interpreter`);
    if (first === "npx") assert.ok(second && /^[a-z@]/.test(second), `${entry} allows npx without a named tool`);
  }
});

// capsid/research/design-seat-session-hardening.md, PR 1: the first-run fix, the
// credential scrub, the read and edit denies, and git that runs no code of the
// session's writing.

function allowedList(flag: "allowedTools" | "disallowedTools"): string[] {
  const m = new RegExp(`--${flag} "([^"]*)"`).exec(CODE);
  assert.ok(m, `no --${flag} parsed`);
  return m[1].split(",").map((e) => e.trim());
}

// The settings input is JSON in a YAML block scalar; the Action writes it to user
// scope, where the sandbox credential keys are honoured.
interface SandboxSettings {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  allowUnsandboxedCommands?: boolean;
  network?: { allowedDomains?: string[]; strictAllowlist?: boolean };
  filesystem?: { denyWrite?: string[]; denyRead?: string[] };
  credentials?: { envVars?: { name: string; mode: string }[] };
}

function settings(): { permissions?: { deny?: string[] }; sandbox?: SandboxSettings } {
  const m = /^ {10}settings: \|\n((?: {12}.*\n)+)/m.exec(CODE);
  assert.ok(m, "no settings block parsed");
  return JSON.parse(m[1]);
}

test("the Action gets its GitHub token from the workflow, so the first run does not need an OIDC exchange", () => {
  // Without it, src/github/token.ts in the Action calls core.getIDToken and throws.
  assert.match(CODE, /^ {10}github_token: \$\{\{ github\.token \}\}$/m);
});

test("subprocess credentials are scrubbed and git reads no global or system config", () => {
  const env = /^ {4}env:\n((?: {6}.*\n)+)/m.exec(CODE);
  assert.ok(env, "no job-level env parsed");
  assert.match(env[1], /^ {6}CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"$/m);
  assert.match(env[1], /^ {6}GIT_CONFIG_GLOBAL: \/dev\/null$/m);
  assert.match(env[1], /^ {6}GIT_CONFIG_NOSYSTEM: "1"$/m);
});

test("the repo's git config runs no hooks and no fsmonitor, set after checkout and before the session", () => {
  const checkout = CODE.indexOf("actions/checkout@");
  const hooks = CODE.indexOf("git config core.hooksPath /dev/null");
  const fsmonitor = CODE.indexOf("git config core.fsmonitor false");
  const session = CODE.indexOf("anthropics/claude-code-action@");
  assert.ok(checkout >= 0 && session >= 0, "checkout or the Action not found");
  assert.ok(hooks > checkout && hooks < session, "core.hooksPath is not pinned between checkout and the session");
  assert.ok(fsmonitor > checkout && fsmonitor < session, "core.fsmonitor is not pinned between checkout and the session");
});

const GIT_ALLOWED = new Set([
  "Bash(git status)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git add:*)",
  "Bash(git commit -m:*)",
  "Bash(git switch -c:*)",
  // No -u: it records the upstream in .git/config, which the sandbox denies writes to.
  "Bash(git push origin:*)",
  "Bash(git rev-parse:*)",
]);

test("git is allowed by named subcommand only, and the config-changing forms are refused", () => {
  const git = allowedList("allowedTools").filter((e) => /^Bash\(git\b/.test(e));
  assert.ok(git.length > 0, "no git entries parsed");
  for (const entry of git) assert.ok(GIT_ALLOWED.has(entry), `${entry} is not a named git subcommand`);
  const refused = allowedList("disallowedTools");
  for (const entry of ["Bash(git -c:*)", "Bash(git config:*)", "Bash(git -C:*)", "Bash(git push * --force*)", "Bash(git push * -f*)", "Bash(git push * +*)", "Bash(git push * --delete*)"]) {
    assert.ok(refused.includes(entry), `${entry} is not refused`);
  }
});

test("the session cannot read the key file or process environments, or edit git config", () => {
  const deny = settings().permissions?.deny ?? [];
  for (const rule of ["Read(//proc/**)", "Read(/${{ runner.temp }}/**)", "Edit(**/.git/**)", "Edit(~/.gitconfig)", "Edit(~/.config/git/**)"]) {
    assert.ok(deny.includes(rule), `${rule} is not in permissions.deny`);
  }
});

test("the credential variables are named in the sandbox deny list", () => {
  const envVars = settings().sandbox?.credentials?.envVars ?? [];
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "DEFAULT_WORKFLOW_TOKEN"]) {
    assert.ok(envVars.some((v) => v.name === name && v.mode === "deny"), `${name} is not denied`);
  }
});

// capsid/research/design-seat-session-hardening.md, PR 4, ruled C (capsid/decisions.md,
// 2026-09-26, "sandbox and sudo conflict ruled C"): harden-runner watches egress with
// sudo still on, the sandbox's prerequisites go in, then our own step removes sudo and
// containers before any repo code or the session runs.

// The workflow's steps in order, each as its own text, so a property can be asserted
// of one step rather than of the whole file.
function steps(): string[] {
  const body = CODE.slice(CODE.indexOf("\n    steps:\n"));
  return body.split(/\n {6}- /).slice(1);
}

const stepIndex = (marker: RegExp) => steps().findIndex((s) => marker.test(s));

test("harden-runner is the first step, pinned, and carries no sudo option", () => {
  const all = steps();
  assert.ok(all.length > 5, `only ${all.length} steps parsed`);
  assert.match(all[0], /^uses: step-security\/harden-runner@[0-9a-f]{40} # v\d+\.\d+\.\d+/, "harden-runner is not the first step, pinned by sha");
  // Its pre hook would remove sudo before the sandbox setup could run.
  assert.doesNotMatch(all[0], /disable-sudo/, "harden-runner carries a sudo option");
  // PR 5b: block, now that the audit canary (actions run 36296347138) recorded the list.
  assert.match(all[0], /^ {10}egress-policy: block$/m);
  assert.doesNotMatch(all[0], /egress-policy: audit/);
});

// capsid/research/design-seat-session-hardening.md, PR 5b. Every host the audit-mode
// canary (actions run 36296347138) reached, less the probe's raw socket and Claude
// Code's metrics host. GitHub's Actions hosts are the agent's own implicit list.
const ALLOWED_ENDPOINTS = [
  "mcp.dustinedwards.info:443",
  "github.com:443",
  "api.github.com:443",
  "release-assets.githubusercontent.com:443",
  "registry.npmjs.org:443",
  "claude.ai:443",
  "downloads.claude.ai:443",
  "api.anthropic.com:443",
  "azure.archive.ubuntu.com:80",
  "packages.microsoft.com:443",
  "esm.ubuntu.com:443",
  "motd.ubuntu.com:443",
];

// The input as the agent receives it: a folded scalar joins its lines with spaces, and
// step-security/agent config.go parseEndpoints splits on spaces only.
function allowedEndpoints(): { indicator: string; entries: string[] } {
  const m = /^ {10}allowed-endpoints: ([>|][+-]?)\n((?: {12}.*\n)+)/m.exec(steps()[0] ?? "");
  assert.ok(m, "no allowed-endpoints block parsed on the harden-runner step");
  const lines = m[2].split("\n").filter((l) => l.length > 0).map((l) => l.slice(12));
  const value = m[1].startsWith(">") ? lines.join(" ") : lines.join("\n");
  return { indicator: m[1], entries: value.split(" ").filter((e) => e.length > 0) };
}

test("the egress list is the recorded one, folded so the agent reads one entry per host", () => {
  const { indicator, entries } = allowedEndpoints();
  // A literal block keeps its newlines, and the agent would read "a:443\nb:443" as one host.
  assert.ok(indicator.startsWith(">"), `allowed-endpoints is a ${indicator} scalar, not folded`);
  assert.deepEqual(entries, ALLOWED_ENDPOINTS);
  for (const entry of entries) assert.match(entry, /^[a-z0-9.-]+\.[a-z]+:(443|80)$/, `${entry} is not a named host with a port`);
});

test("the probe's raw socket and the metrics host stay off the egress list", () => {
  const { entries } = allowedEndpoints();
  for (const entry of entries) {
    assert.doesNotMatch(entry, /^\d+\.\d+\.\d+\.\d+:/, `${entry} is an IP address`);
    assert.doesNotMatch(entry, /datadoghq|\*/, `${entry} is the metrics host or a wildcard`);
  }
});

test("the steps run in the ruled order: harden-runner, sandbox setup, lockdown, key exchange, checkout, session", () => {
  const order = [
    /^uses: step-security\/harden-runner@/,
    /^name: Validate the job id/,
    /^name: Install the sandbox's prerequisites/,
    /^name: Remove sudo and containers/,
    /^name: Exchange this run's OIDC token/,
    /^uses: actions\/checkout@/,
    /^name: Install dependencies/,
    /^uses: anthropics\/claude-code-action@/,
  ].map(stepIndex);
  for (const [i, at] of order.entries()) assert.ok(at >= 0, `step ${i} of the ruled order is missing`);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `step ${i} of the ruled order runs before step ${i - 1}`);
});

test("the sandbox setup installs bubblewrap and socat and writes Anthropic's bwrap profile as published", () => {
  const setup = steps()[stepIndex(/^name: Install the sandbox's prerequisites/)] ?? "";
  assert.match(setup, /apt-get install -y --no-install-recommends bubblewrap socat/);
  // The profile text from code.claude.com/docs/en/sandboxing, Ubuntu 24.04 and later.
  const profile = ["abi <abi/4.0>,", "include <tunables/global>", "", "profile bwrap /usr/bin/bwrap flags=(unconfined) {", "  userns,", "  include if exists <local/bwrap>", "}"];
  const body = /sudo tee \/etc\/apparmor\.d\/bwrap > \/dev\/null <<'EOF'\n([\s\S]*?)\n {10}EOF\n/.exec(setup);
  assert.ok(body, "the bwrap profile heredoc is not there");
  assert.deepEqual(body[1].split("\n").map((l) => l.replace(/^ {10}/, "")), profile, "the bwrap profile differs from Anthropic's");
  assert.match(setup, /sudo systemctl reload apparmor/);
  // Proves namespaces work before anything relies on them.
  assert.match(setup, /bwrap --ro-bind \/ \/ --dev \/dev --unshare-all true/);
});

test("the lockdown mirrors disable-sudo-and-containers, removes every sudo grant last, and fails closed", () => {
  const lock = steps()[stepIndex(/^name: Remove sudo and containers/)] ?? "";
  assert.match(lock, /set -euo pipefail/);
  for (const line of [
    /sudo systemctl disable --now docker\.socket docker\.service containerd\.service/,
    /sudo rm -f \/var\/run\/docker\.sock \/run\/containerd\/containerd\.sock/,
    /sudo apt-get purge -y docker-ce docker-ce-cli containerd\.io/,
    /sudo rm -rf \/var\/lib\/docker \/var\/lib\/containerd/,
    /sudo rm -f \/etc\/apt\/sources\.list\.d\/docker\.list \/etc\/apt\/keyrings\/docker\.asc/,
  ]) {
    assert.match(lock, line, `the lockdown lacks ${line}`);
  }
  // Every file under sudoers.d, in one sudo call, after the container teardown that
  // needs sudo.
  const revoke = lock.indexOf(`sudo sh -c 'for f in /etc/sudoers.d/*; do : > "$f"; done'`);
  assert.ok(revoke > lock.indexOf("apt-get purge"), "sudo is not revoked last");
  // Then checked, and a lockdown that did not take stops the job.
  assert.match(lock, /if sudo -n true 2>\/dev\/null; then[^\n]*exit 1/);
  assert.match(lock, /\/var\/run\/docker\.sock[^\n]*exit 1|exit 1[^\n]*\/var\/run\/docker\.sock/);
});

test("the sandbox is required, allows only github.com, and denies writes to the repo's git config and hooks", () => {
  const sandbox = settings().sandbox ?? {};
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true, "a sandbox that cannot start would fall back to unsandboxed Bash");
  assert.equal(sandbox.allowUnsandboxedCommands, false, "Claude could retry a command outside the sandbox");
  assert.deepEqual(sandbox.network?.allowedDomains, ["github.com"]);
  assert.equal(sandbox.network?.strictAllowlist, true);
  // Absolute: in user settings a relative sandbox path resolves against ~/.claude.
  assert.deepEqual(sandbox.filesystem?.denyWrite, ["${{ github.workspace }}/.git/config", "${{ github.workspace }}/.git/hooks"]);
  // The design's section 2d: sandbox reads default to everywhere, so without this a
  // test file could read the Capsid key the exchange wrote to the runner temp folder.
  assert.deepEqual(sandbox.filesystem?.denyRead, ["${{ runner.temp }}"]);
});

// capsid/research/design-seat-session-hardening.md, PR 5a. The first hardened canary run
// (actions run 36286555290) logged in to Capsid but never claimed: with
// ENABLE_TOOL_SEARCH unset, Claude Code defers every MCP tool behind ToolSearch, which
// the allowed-tools list does not name, and the one permission denial was the result.

const actionStep = () => steps()[stepIndex(/^uses: anthropics\/claude-code-action@/)] ?? "";

test("the session loads its MCP tools at startup, so the Capsid tools need no ToolSearch", () => {
  const step = actionStep();
  assert.match(step, /^ {8}id: session$/m, "the Action step has no id for the diagnostics step to read");
  assert.match(step, /^ {8}env:\n {10}ENABLE_TOOL_SEARCH: "false"$/m, "ENABLE_TOOL_SEARCH is not false on the Action step");
});

// PR 5b: the metrics host is off the egress list, so the session must not need it.
test("the session sends no nonessential traffic, so nothing needs the metrics host", () => {
  assert.match(actionStep(), /^ {8}env:\n(?: {10}.*\n)*? {10}CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"$/m);
});

test("the prompt stops the session at once when the Capsid jobs tool is missing", () => {
  assert.match(actionStep(), /If the capsid `jobs` tool \(mcp__capsid__jobs\) is not available, stop at once/);
});

// capsid job_5765103c658f: the dustinedwards block-mode canary (actions run
// 36308451713) never committed. Its CLAUDE.md sends every actor but the site session
// to a worktree, and its project hooks run outside the sandbox, one of them running
// lint on every push.

test("the prompt tells the session its runner checkout is its own clone", () => {
  assert.match(actionStep(), /This runner checkout is your own clone\. It is not the main checkout that\n {12}CLAUDE\.md or a ruling reserves for another session; work here, on a new branch\./);
});

test("every hook is off through flag settings, which outrank the repo's own settings", () => {
  const m = /--settings '([^']*)'/.exec(actionStep());
  assert.ok(m, "no --settings in claude_args");
  assert.deepEqual(JSON.parse(m[1]), { disableAllHooks: true });
  // In the Action's settings input it would land in user scope, which a repo's project
  // or local settings outrank.
  assert.equal("disableAllHooks" in settings(), false, "disableAllHooks is in the user-scope settings input");
});

const TRIPWIRE_PATH = "${{ runner.temp }}/hook-tripwire";

test("a local-scope hook tripwire is planted after checkout and before the session, and never overwrites a file", () => {
  const at = stepIndex(/^name: Plant a hook tripwire/);
  assert.ok(at > stepIndex(/^uses: actions\/checkout@/) && at < stepIndex(/^uses: anthropics\/claude-code-action@/), "the tripwire is not between checkout and the session");
  const step = steps()[at];
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /if \[ -e \.claude\/settings\.local\.json \]; then[^\n]*exit 1; fi/, "the tripwire would overwrite an existing local settings file");
  assert.match(step, /echo "\.claude\/settings\.local\.json" >> \.git\/info\/exclude/);
  const body = /cat > \.claude\/settings\.local\.json <<'EOF'\n {10}(.*)\n {10}EOF\n/.exec(step);
  assert.ok(body, "no tripwire settings heredoc parsed");
  const hooks = (JSON.parse(body[1]) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "SessionStart", "UserPromptSubmit"]);
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.equal(h.command, `touch ${TRIPWIRE_PATH}`, `${event} does something besides touching the tripwire`);
  }
  const diag = steps()[stepIndex(/^name: Report the session's MCP servers and denied tools/)] ?? "";
  assert.ok(diag.includes(`TRIPWIRE: ${TRIPWIRE_PATH}`), "the report step reads a different tripwire path");
});

const DIAG_KEYS = ["capsid_jobs_loaded", "denied_bash", "denied_tools", "hooks_fired", "init_seen", "mcp_servers", "read_error", "result_seen"];

function runDiagnostics(executionFile: string, tripwire = join(tmpdir(), "no-such-hook-tripwire"), expectStatus = 0): string {
  const all = steps();
  const at = stepIndex(/^name: Report the session's MCP servers and denied tools/);
  assert.ok(at > stepIndex(/^uses: anthropics\/claude-code-action@/), "the diagnostics step does not follow the Action");
  const step = all[at];
  assert.match(step, /^ {8}if: always\(\)$/m, "the diagnostics step is skipped when the session fails");
  assert.match(step, /EXECUTION_FILE: \$\{\{ steps\.session\.outputs\.execution_file \}\}/);
  const script = /node -e '\n([\s\S]*?)\n {10}'/.exec(step)?.[1];
  assert.ok(script, "no node script parsed in the diagnostics step");
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, EXECUTION_FILE: executionFile, TRIPWIRE: tripwire }, encoding: "utf8" });
  assert.equal(r.status, expectStatus, r.stderr);
  return r.stdout;
}

const parseDiag = (out: string) => JSON.parse(out.trim().slice("SESSION_DIAG ".length));

test("the diagnostics step prints names, statuses and booleans only, from a transcript full of secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-diag-"));
  const file = join(dir, "claude-execution-output.json");
  const SECRET = "sk-ant-oat01-canary-not-a-real-token";
  writeFileSync(
    file,
    JSON.stringify([
      { type: "system", subtype: "init", model: "m", apiKeySource: SECRET, cwd: `/home/${SECRET}`, tools: ["Read", "mcp__capsid__jobs"], mcp_servers: [{ name: "capsid", status: "connected", config: { headers: { Authorization: `Bearer ${SECRET}` } } }] },
      { type: "assistant", message: { content: [{ type: "text", text: SECRET }] } },
      {
        type: "result",
        subtype: "success",
        result: SECRET,
        permission_denials: [
          { tool_name: "ToolSearch", tool_use_id: "x", tool_input: { query: SECRET } },
          { tool_name: "Bash", tool_use_id: "y", tool_input: { command: `git worktree add ../wt ${SECRET}` } },
          { tool_name: "Bash", tool_use_id: "z", tool_input: { command: `${SECRET} curl -H "Authorization: Bearer ${SECRET}"` } },
        ],
      },
    ])
  );
  const out = runDiagnostics(file);
  assert.doesNotMatch(out, /canary-not-a-real-token/, "the diagnostics step printed a value from the transcript");
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1, `the diagnostics step printed ${lines.length} lines`);
  assert.match(lines[0], /^SESSION_DIAG \{/);
  const diag = JSON.parse(lines[0].slice("SESSION_DIAG ".length));
  assert.deepEqual(Object.keys(diag).sort(), DIAG_KEYS);
  assert.deepEqual(diag.mcp_servers, [{ name: "capsid", status: "connected" }]);
  assert.deepEqual(diag.denied_tools, ["ToolSearch", "Bash", "Bash"]);
  // First two words only; a word that is not a command word prints as <redacted>.
  assert.deepEqual(diag.denied_bash, ["git worktree", "<redacted> curl"]);
  assert.equal(diag.capsid_jobs_loaded, true);
  assert.equal(diag.hooks_fired, false);
  assert.equal(diag.read_error, false);
});

test("the diagnostics step says so when there is no transcript, rather than printing nothing", () => {
  const diag = parseDiag(runDiagnostics(join(tmpdir(), "no-such-execution-file.json")));
  assert.equal(diag.read_error, true);
  assert.equal(diag.init_seen, false);
});

test("a fired hook tripwire is reported and fails the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-tripwire-"));
  const tripwire = join(dir, "hook-tripwire");
  writeFileSync(tripwire, "");
  const diag = parseDiag(runDiagnostics(join(dir, "no-execution-file.json"), tripwire, 1));
  assert.equal(diag.hooks_fired, true);
});
