// Install, remove or run the nightly /improve work driver, one Windows Task
// Scheduler task per project folder.
//
//   node scripts/schedule-drivers.mjs --list
//   node scripts/schedule-drivers.mjs --install                      # dry run, every namespace
//   node scripts/schedule-drivers.mjs --install --namespace capsid --apply
//   node scripts/schedule-drivers.mjs --remove --namespace capsid --apply
//   node scripts/schedule-drivers.mjs --run --namespace capsid       # what the task invokes
//
// WHY A LOCAL TASK AND NOT A CLOUD ROUTINE. Ruled 2026-09-12 after measuring the
// routine API (capsid/autonomy-part3-routines.md). A Claude Code cloud routine can
// only attach claude.ai connectors, and the registered Capsid connector points at
// /mcp, the OAuth admin path. A nightly routine would therefore run the whole queue
// as the admin, with every namespace and every blast-radius flag, which is the wide
// credential the per-namespace driver agents were minted to replace. There is also
// no verified way to hand a routine a secret. On this machine the per-namespace key
// files already exist and the credential model already holds, so the scheduler runs
// here and each task reaches Capsid as exactly one driver.
//
// OFF BY DEFAULT, TWICE OVER. Nothing is created without --apply, and an installed
// task is created DISABLED, from a task XML whose settings say so (taskXml), so it
// never exists enabled. Enabling it is a separate, deliberate act:
//
//   schtasks /Change /TN "<task name>" /ENABLE
//
// A scheduler that armed itself on install would be a nightly unattended agent
// nobody decided to switch on.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { capsidClient } from "./capsid-rpc.mjs";

const ORIGIN_DEFAULT = "https://capsid.dustin-edwards.workers.dev";

// The namespace to repo-folder map, the same one .claude/commands/improve.md carries.
// A namespace with no folder here is not schedulable from this machine.
/** @type {Record<string, string>} */
const FOLDERS = {
  capsid: "C:\\Users\\email\\dev\\capsid-mcp",
  dustinedwards: "C:\\Users\\email\\dev\\dustinedwards-info",
  foxhound: "C:\\Users\\email\\dev\\foxhound",
  foxing: "C:\\Users\\email\\dev\\foxing",
  germomics: "C:\\Users\\email\\dev\\germomics",
};

// 04:00 America/Chicago. schtasks takes a LOCAL wall-clock time and the machine is
// already on America/Chicago, so this is 04:00 all year and the task does not drift
// across the daylight-saving switch the way a UTC cron expression would. That is the
// one thing a local scheduler does better than the Worker's own cron, which needs two
// expressions and chicagoHour() to pin the same instant.
const START_TIME = "04:00";

/** @param {string} ns */
export const taskName = (ns) => `Capsid improve driver (${ns})`;
/** @param {string} ns */
export const keyPath = (ns) => join(homedir(), ".capsid", `agent-${ns}-driver.key`);

/**
 * @param {string[]} argv
 * @returns {{ mode: "install" | "remove" | "run" | "list"; namespace: string | undefined; apply: boolean }}
 */
export function parseArgs(argv) {
  /** @type {{ mode: "install" | "remove" | "run" | "list" | null; namespace: string | undefined; apply: boolean }} */
  const out = { mode: null, namespace: undefined, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--install" || arg === "--remove" || arg === "--run" || arg === "--list") {
      out.mode = /** @type {"install" | "remove" | "run" | "list"} */ (arg.slice(2));
    }
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--namespace") {
      // A value-less flag used to leave the namespace undefined, which selects all five.
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--namespace needs a value, for example --namespace capsid.");
      out.namespace = value;
    }
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (!out.mode) throw new Error("one of --install, --remove, --run or --list is required.");
  if (out.mode === "run" && !out.namespace) throw new Error("--run needs --namespace.");
  if (out.namespace !== undefined && !Object.hasOwn(FOLDERS, out.namespace)) {
    throw new Error(`'${out.namespace}' has no repo folder on this machine. Known: ${Object.keys(FOLDERS).join(", ")}`);
  }
  return { ...out, mode: out.mode };
}

/** @param {string | undefined} namespace */
export function selected(namespace) {
  return namespace ? [namespace] : Object.keys(FOLDERS);
}

/**
 * @param {string[]} args
 * @returns {{ code: number; out: string }}
 */
export function schtasks(args) {
  const res = spawnSync("schtasks", args, { encoding: "utf8" });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

/**
 * @param {string} ns
 * @param {typeof schtasks} [run]
 */
export function taskExists(ns, run = schtasks) {
  return run(["/Query", "/TN", taskName(ns)]).code === 0;
}

// ---- the log the nightly run leaves behind --------------------------------------

// The Chicago day, because the run is scheduled by Chicago wall clock and a log named
// by the UTC day would file a 04:00 run under the previous date for half the year.
export function chicagoDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** @param {string} day */
export const logPath = (day) => `jobs/nightly-${day}.md`;

// Bounded, because a driver session's transcript is unbounded and this lands in a
// document somebody reads. The tail is kept rather than the head: what a run ended
// with is what says whether it finished, blocked, or died.
export const LOG_BUDGET = 24_000;

/**
 * @param {string} ns
 * @param {{ exitCode: number; output: string; started: string; finished: string }} run
 */
export function renderLog(ns, { exitCode, output, started, finished }) {
  const trimmed =
    output.length > LOG_BUDGET
      ? `[${output.length - LOG_BUDGET} earlier characters omitted]\n\n${output.slice(-LOG_BUDGET)}`
      : output;
  const verdict = exitCode === 0 ? "finished" : `exited ${exitCode}`;
  return [
    `# Nightly driver run, ${ns}`,
    "",
    `Written by scripts/schedule-drivers.mjs on the machine that holds this namespace's driver key.`,
    "",
    `- started: ${started}`,
    `- finished: ${finished}`,
    `- claude exit code: ${exitCode} (${verdict})`,
    "",
    "## Output",
    "",
    "```",
    trimmed,
    "```",
    "",
  ].join("\n");
}

// Throws when the write tool refuses, so a refused log is never reported as posted.
/**
 * @param {string} ns
 * @param {{ tool(name: string, args: object): Promise<string> }} client
 * @param {string} body
 * @param {string} day
 */
export async function postLog(ns, client, body, day) {
  return client.tool("write", {
    namespace: ns,
    path: logPath(day),
    title: `Nightly driver run, ${ns}, ${day}`,
    type: "reference",
    tags: "jobs,nightly",
    body,
    confirm: true,
  });
}

// ---- run ------------------------------------------------------------------------

// HOW THE DRIVER SESSION IS PERMITTED. `claude -p` starts in Manual mode on every plan
// and has nobody to answer a prompt, so until 2026-09-23 every nightly run was denied
// its first tool call (mcp__capsid__improve_status) and did nothing
// (dustinedwards/jobs/nightly-2026-09-23.md). Auto mode has the classifier review what
// no rule settles. The mode that skips permission checks is never used here: it
// would also stop the classifier from reviewing anything no rule names.

// Capsid tools pre-approved for the driver: every tool whose TOOL_GRANTS entry in
// src/scope.ts is "read", plus the two whose requirement is per action and which the
// /improve loop drives (jobs, improve_run). The Worker still enforces the driver's own
// scope on each call, so this list removes a prompt and grants nothing. Every other
// Capsid tool, the document and repo write tools included, goes to the classifier.
export const DRIVER_CAPSID_TOOLS = [
  "list",
  "read",
  "brief",
  "backlinks",
  "find",
  "search",
  "namespaces",
  "history",
  "list_repo_tree",
  "read_repo_file",
  "search_code",
  "repo_refs",
  "repo_history",
  "ci_status",
  "improve_status",
  "improve_run",
  "jobs",
];

// Blocked outright, in every mode. Deploys and ships are the human's gate, and a force
// push can rewrite a branch someone else is on. Each command is listed for both shell
// tools, and a push is listed with and without `git -C <dir>`, because the /improve
// command's own push shape names the directory. The claude.ai Capsid connector is
// denied whole: it reaches /mcp as the OAuth admin, and a driver session must reach
// Capsid only as its own agent.
const DENIED_COMMANDS = [
  "npm run ship*",
  "npm run deploy*",
  "wrangler deploy*",
  "npx wrangler deploy*",
  // The same deploy reached another way: the script behind `npm run deploy`, npm's
  // long spelling of `run`, and a version-pinned wrangler.
  "node scripts/deploy.mjs*",
  "npm run-script ship*",
  "npm run-script deploy*",
  "npx wrangler@* deploy*",
  "git push --force*",
  "git push -f*",
  "git push * --force*",
  "git push * -f*",
  "git -C * push --force*",
  "git -C * push -f*",
  "git -C * push * --force*",
  "git -C * push * -f*",
  // A refspec with a leading + is a force push of that one branch.
  "git push * +*",
  "git -C * push * +*",
];
export const DRIVER_DENIED = [
  ...DENIED_COMMANDS.flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]),
  "mcp__claude_ai_Capsid",
];

// Where the claude-skills and dustinedwards drivers do their work (improve.md). A read
// outside the working directory prompts even in auto mode, and a -p run denies it.
const WORKTREES = "C:\\Users\\email\\dev\\worktrees";

export function driverArgs() {
  return [
    "-p", "/improve work",
    "--permission-mode", "auto",
    // Anything that would still fall back to a prompt is denied at once, and the model
    // is told nobody can approve it, rather than retrying.
    "--permission-prompts", "none",
    "--add-dir", WORKTREES,
    "--allowedTools", DRIVER_CAPSID_TOOLS.map((t) => `mcp__capsid__${t}`).join(","),
    "--disallowedTools", DRIVER_DENIED.join(","),
  ];
}

/** @param {string} ns */
async function runOne(ns) {
  const folder = FOLDERS[ns];
  const key = process.env.CAPSID_DRIVER_KEY ?? readKey(ns);
  const started = new Date().toISOString();
  // The driver session. Its own credential comes from the project-scoped MCP server
  // configured in that folder, not from this process: the key read above is only for
  // posting the log afterwards, so a failed run still records something.
  // No shell: the arguments carry `*`, `(` and spaces, and passing them as an argv
  // keeps cmd.exe from reading any of them.
  const res = spawnSync("claude", driverArgs(), {
    cwd: folder,
    encoding: "utf8",
    timeout: 4 * 60 * 60 * 1000,
  });
  const finished = new Date().toISOString();
  // A claude that never started leaves no stdout, only res.error.
  const spawnError = res.error ? `\n${res.error.message}` : "";
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}${spawnError}`.trim() || "(no output)";
  const exitCode = res.status ?? 1;

  const day = chicagoDay(new Date());
  const body = renderLog(ns, { exitCode, output, started, finished });
  if (!key) {
    console.error(`no driver key for ${ns} at ${keyPath(ns)}; the run finished but its log was not posted.`);
    console.log(body);
    return exitCode;
  }
  try {
    const client = capsidClient(process.env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT, key, "schedule-drivers");
    await postLog(ns, client, body, day);
    console.log(`posted ${ns}/${logPath(day)}`);
  } catch (err) {
    // A log that could not be posted does not change what the run did. It goes to
    // stdout, which Task Scheduler keeps, rather than being lost.
    console.error(`could not post the run log for ${ns}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(body);
  }
  return exitCode;
}

// The key is read to POST the run log and for nothing else; the driver session gets
// its own credential from the project-scoped MCP server in that folder. It is never
// printed, on the same rule as scripts/mint-agents.mjs.
/** @param {string} ns */
function readKey(ns) {
  const path = keyPath(ns);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim();
}

// ---- install and remove ---------------------------------------------------------

// The task runs THIS script in --run mode. A task that invoked `claude` directly
// could not post a log for a session that died, which is the run whose log matters
// most.
//
// The script path is the capsid clone in FOLDERS, not process.cwd(). An install run
// from another folder, or from a worktree that is later deleted, would otherwise
// schedule a path that does not exist, and the task would fail every night.
// win32.join, because the task runs on Windows whatever platform builds its XML.
const installScript = () => win32.join(FOLDERS.capsid, "scripts", "schedule-drivers.mjs");
/** @param {string} ns */
const installArguments = (ns) => `"${installScript()}" --run --namespace ${ns}`;

/** @param {string} ns */
export function installCommand(ns) {
  return `node ${installArguments(ns)}`;
}

/** @param {unknown} s */
const xmlEscape = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// The task definition, for `schtasks /Create /XML`. <Settings><Enabled>false</Enabled>
// is why this is XML: schtasks /Create has no switch for a disabled task, so creating
// it with /TR and then running /Change /DISABLE left a window in which the task existed
// ENABLED, and a failed /Change left it that way. Created from this document, the task
// is disabled from the moment it exists.
//
// Every setting not named here takes the Task Scheduler default, which is what the
// /TR form got. The start date is only the day the daily trigger begins counting from;
// with no time zone the time is local wall clock (see START_TIME).
/** @param {string} ns */
export function taskXml(ns) {
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>${xmlEscape(`${taskName(ns)}. Written by scripts/schedule-drivers.mjs.`)}</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <CalendarTrigger>`,
    `      <StartBoundary>2026-01-01T${START_TIME}:00</StartBoundary>`,
    `      <ScheduleByDay>`,
    `        <DaysInterval>1</DaysInterval>`,
    `      </ScheduleByDay>`,
    `    </CalendarTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <Enabled>false</Enabled>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>node</Command>`,
    `      <Arguments>${xmlEscape(installArguments(ns))}</Arguments>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

// Each returns { ok, line }. ok is false on any failure, so main exits non-zero.
/**
 * @param {string} ns
 * @param {boolean} apply
 * @param {typeof schtasks} [run]
 * @returns {{ ok: boolean; line: string }}
 */
export function install(ns, apply, run = schtasks) {
  const exists = taskExists(ns, run);
  const command = installCommand(ns);
  if (!apply) {
    return { ok: true, line: `${exists ? "REPLACE" : "CREATE "} ${taskName(ns)}  daily ${START_TIME}  ${command}  (created disabled)` };
  }
  // CREATED DISABLED, in the one call that creates it. See the header: install is not
  // the same act as switching on a nightly unattended agent, and conflating them is how
  // one ends up running because somebody ran a setup script. The file is UTF-16 LE with
  // a byte-order mark, the encoding the XML declares and the one schtasks reads.
  const dir = mkdtempSync(join(tmpdir(), "capsid-task-"));
  const file = join(dir, "task.xml");
  try {
    writeFileSync(file, `﻿${taskXml(ns)}`, "utf16le");
    const created = run(["/Create", "/XML", file, "/TN", taskName(ns), "/F"]);
    if (created.code !== 0) return { ok: false, line: `FAILED  ${taskName(ns)}: ${created.out}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: true, line: `created ${taskName(ns)}, DISABLED. Enable with: schtasks /Change /TN "${taskName(ns)}" /ENABLE` };
}

/**
 * @param {string} ns
 * @param {boolean} apply
 * @param {typeof schtasks} [run]
 * @returns {{ ok: boolean; line: string }}
 */
export function remove(ns, apply, run = schtasks) {
  if (!taskExists(ns, run)) return { ok: true, line: `absent  ${taskName(ns)}` };
  if (!apply) return { ok: true, line: `DELETE  ${taskName(ns)}` };
  const res = run(["/Delete", "/TN", taskName(ns), "/F"]);
  return res.code === 0 ? { ok: true, line: `deleted ${taskName(ns)}` } : { ok: false, line: `FAILED  ${taskName(ns)}: ${res.out}` };
}

// Install needs the key file, because the task it creates posts its log with it.
// REMOVE DOES NOT: a task whose key was revoked and deleted must still be removable,
// and requiring the file left exactly that task running every night.
/**
 * @param {string} mode
 * @param {string[]} targets
 * @param {boolean} apply
 * @param {{ run?: typeof schtasks; hasKey?: (ns: string) => boolean; log?: (line: string) => void }} [deps]
 */
export function manage(mode, targets, apply, { run = schtasks, hasKey = (ns) => existsSync(keyPath(ns)), log = console.log } = {}) {
  let failed = 0;
  for (const ns of targets) {
    if (mode === "install" && !hasKey(ns)) {
      log(`SKIP    ${ns}: no key file at ${keyPath(ns)}. Mint it before scheduling a driver for it.`);
      continue;
    }
    const { ok, line } = mode === "install" ? install(ns, apply, run) : remove(ns, apply, run);
    if (!ok) failed += 1;
    log(`  ${line}`);
  }
  return failed;
}

function list() {
  for (const ns of Object.keys(FOLDERS)) {
    const state = taskExists(ns) ? "installed" : "not installed";
    const keyState = existsSync(keyPath(ns)) ? "key present" : "NO KEY FILE";
    console.log(`  ${ns.padEnd(16)} ${state.padEnd(14)} ${keyState}`);
  }
}

async function main() {
  const { mode, namespace, apply } = parseArgs(process.argv.slice(2));
  if (mode === "list") return list();
  if (mode === "run") process.exit(await runOne(/** @type {string} */ (namespace)));

  const failed = manage(mode, selected(namespace), apply);
  if (!apply) console.log("\nDry run. Re-run with --apply to change anything.");
  if (failed > 0) {
    console.error(`\n${failed} task(s) FAILED.`);
    process.exitCode = 1;
  }
}

// Only when executed, so the pure helpers above are importable by the test suite.
if (process.argv[1] && process.argv[1].endsWith("schedule-drivers.mjs")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
