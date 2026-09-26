import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error a plain .mjs script with no type declarations, imported for its pure helpers
import { DRIVER_CAPSID_TOOLS, DRIVER_DENIED, LOG_BUDGET, chicagoDay, driverArgs, install, installCommand, keyPath, logPath, manage, parseArgs, postLog, renderLog, selected, taskName } from "../scripts/schedule-drivers.mjs";
import { capsidClient } from "../scripts/capsid-rpc.mjs";
import { ROSTER } from "../src/improve-schema.ts";
import { TOOL_GRANTS } from "../src/scope.ts";

// A Windows Task Scheduler task per project folder rather than a cloud routine,
// because a routine can only reach Capsid as the OAuth admin.

const SOURCE = readFileSync(join(import.meta.dirname, "..", "scripts", "schedule-drivers.mjs"), "utf8");
// The key reaches the network through the shared client, so its rule is checked there too.
const RPC_SOURCE = readFileSync(join(import.meta.dirname, "..", "scripts", "capsid-rpc.mjs"), "utf8");

test("every roster namespace has a repo folder, so none is silently unschedulable", () => {
  assert.deepEqual([...selected(undefined)].sort(), [...ROSTER].sort());
});

test("the task name and the key path are per namespace, so one task is one driver", () => {
  assert.equal(taskName("capsid"), "Capsid improve driver (capsid)");
  assert.notEqual(taskName("capsid"), taskName("foxing"));
  assert.match(String(keyPath("foxing")), /agent-foxing-driver\.key$/);
});

// off by default

test("nothing is created without --apply", () => {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return { code: 1, out: "" };
  };
  const { ok, line } = install("capsid", false, run);
  assert.equal(ok, true);
  assert.match(line, /^CREATE /);
  assert.deepEqual(calls.map((c) => c[0]), ["/Query"], "a dry run called schtasks for something other than a query");
});

// the task is created disabled, from XML, in one call

/** Reads a task file the way schtasks does: UTF-16 LE with a byte-order mark. */
function readTaskFile(path: string): string {
  const buf = readFileSync(path);
  assert.deepEqual([buf[0], buf[1]], [0xff, 0xfe], "the task file must start with a UTF-16 LE byte-order mark");
  return buf.subarray(2).toString("utf16le");
}

/** A strict enough well-formedness check for the task XML: one prolog, one root,
 *  every element closed in order, quoted attributes, and no bare & or < in text. */
function assertWellFormed(xml: string) {
  const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  assert.equal(tokens.join(""), xml, "a < that never closes");
  const stack: string[] = [];
  let roots = 0;
  tokens.forEach((token, i) => {
    if (token.startsWith("<?")) {
      assert.equal(i, 0, "the XML declaration must come first");
      assert.match(token, /^<\?xml version="1\.0" encoding="UTF-16"\?>$/);
      return;
    }
    if (token.startsWith("</")) {
      const name = /^<\/([\w:.-]+)\s*>$/.exec(token)?.[1];
      assert.ok(name, `bad closing tag ${token}`);
      assert.equal(stack.pop(), name, `${token} closes the wrong element`);
      return;
    }
    if (token.startsWith("<")) {
      const m = /^<([\w:.-]+)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>$/.exec(token);
      assert.ok(m, `bad tag or unquoted attribute: ${token}`);
      if (stack.length === 0) roots += 1;
      if (!m[3]) stack.push(m[1]);
      return;
    }
    if (stack.length === 0) assert.match(token, /^\s*$/, "text outside the root element");
    assert.equal(/&(?!(amp|lt|gt|quot|apos);)/.test(token), false, `a bare & in text: ${token}`);
  });
  assert.deepEqual(stack, [], "an element was never closed");
  assert.equal(roots, 1, "there must be exactly one root element");
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const element = (xml: string, name: string) => {
  const all = [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
  assert.equal(all.length, 1, `expected one <${name}>, found ${all.length}`);
  return all[0];
};

test("INSTALL CREATES THE TASK DISABLED FROM XML IN ONE CALL, so it never exists enabled", () => {
  for (const ns of selected(undefined)) {
    const calls: string[][] = [];
    let xml = "";
    let xmlPath = "";
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "/Query") return { code: 1, out: "" };
      if (args[0] === "/Create") {
        xmlPath = args[args.indexOf("/XML") + 1];
        xml = readTaskFile(xmlPath);
      }
      return { code: 0, out: "" };
    };
    const { ok, line } = install(ns, true, run);
    assert.equal(ok, true, line);
    assert.match(line, /DISABLED/);
    assert.match(line, /\/ENABLE/, "the operator must be told how to switch it on");

    // One schtasks call changes anything, and it is the XML create. No /Change: the
    // task is not created and then disabled, and install never enables it.
    const changing = calls.filter((c) => c[0] !== "/Query");
    assert.deepEqual(changing, [["/Create", "/XML", xmlPath, "/TN", taskName(ns), "/F"]]);
    assert.equal(existsSync(xmlPath), false, "the temporary task file was left behind");

    assertWellFormed(xml);
    // The one <Enabled> in the document is the task's, under <Settings>, and it is false.
    assert.equal(element(xml, "Enabled"), "false");
    assert.equal(element(element(xml, "Settings"), "Enabled"), "false");
    // What the task runs: this script from the fixed capsid clone, in --run mode.
    assert.equal(unescape(element(xml, "Command")), "node");
    assert.equal(
      unescape(element(xml, "Arguments")),
      `"C:\\Users\\email\\dev\\capsid-mcp\\scripts\\schedule-drivers.mjs" --run --namespace ${ns}`
    );
    assert.equal(unescape(element(xml, "Arguments")), installCommand(ns).replace(/^node /, ""));
    // Daily at 04:00 local time.
    assert.match(element(xml, "StartBoundary"), /^\d{4}-\d{2}-\d{2}T04:00:00$/);
    assert.equal(element(xml, "DaysInterval"), "1");
  }
});

test("a failed XML create is a failure, and the task file is still removed", () => {
  let xmlPath = "";
  const run = (args: string[]) => {
    if (args[0] === "/Create" && args.includes("/XML")) xmlPath = args[args.indexOf("/XML") + 1];
    // /Query fails too, which reads as "no such task", so this is a first install.
    return { code: 1, out: "access denied" };
  };
  const { ok, line } = install("capsid", true, run);
  assert.equal(ok, false);
  assert.match(line, /^FAILED .*access denied/);
  assert.ok(xmlPath, "the create was never attempted");
  assert.equal(existsSync(xmlPath), false);
});

test("the scheduled command runs this script rather than claude directly", () => {
  // A task invoking `claude` straight could not post a log for a session that died.
  // The task's own action is asserted in the XML test; this is the command line.
  assert.match(installCommand("capsid"), /^node "[^"]+schedule-drivers\.mjs" --run --namespace capsid$/);
});

test("the key is read only to post the log, and every use of its VALUE is a bearer header", () => {
  // Not a keyword ban: the variable holding key material is `key`, from readKey, and
  // every interpolation of it must be an Authorization header. The word "key" in a
  // message about a missing file is fine.
  const both = SOURCE + RPC_SOURCE;
  const uses = (both.match(/\$\{key\}/g) ?? []).length;
  const bearers = (both.match(/Authorization: `Bearer \$\{key\}`/g) ?? []).length;
  assert.ok(uses > 0, "the guard must be reading a file that still uses the value");
  assert.equal(bearers, uses, "every interpolation of the key must be a bearer header and nothing else");
  assert.equal(/\$\{readKey\(/.test(SOURCE), false, "the key must not be read straight into a template");
  for (const call of both.match(/console\.(log|error)\([\s\S]{0,160}?\);/g) ?? []) {
    assert.equal(/\$\{key\}/.test(call), false, `a console call interpolates the key: ${call}`);
  }
});

// how the headless driver is permitted

// `claude -p` starts in Manual mode and cannot answer a prompt, so a driver started
// without these flags is denied its first tool call.

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  assert.ok(i >= 0 && i + 1 < args.length, `${name} is missing`);
  return args[i + 1];
};

test("the driver runs in auto mode, and never with permission checks skipped", () => {
  const args: string[] = driverArgs();
  assert.equal(flag(args, "-p"), "/improve work");
  assert.equal(flag(args, "--permission-mode"), "auto");
  assert.equal(flag(args, "--permission-prompts"), "none");
  assert.equal(/bypassPermissions|dangerously-skip-permissions/.test(SOURCE), false);
});

test("the pre-approved Capsid tools are exactly the read tools plus jobs and improve_run", () => {
  // Derived from TOOL_GRANTS in both directions, so a new read tool is either added
  // here or fails this test, and a write tool can never be pre-approved.
  const expected = Object.entries(TOOL_GRANTS)
    .filter(([name, grant]) => grant === "read" || name === "jobs" || name === "improve_run")
    .map(([name]) => name)
    .sort();
  assert.equal(expected.length, 17, "the derived set changed size; check TOOL_GRANTS before trusting this guard");
  assert.deepEqual([...DRIVER_CAPSID_TOOLS].sort(), expected);
  const allowed = flag(driverArgs(), "--allowedTools").split(",");
  assert.deepEqual(allowed.sort(), expected.map((t) => `mcp__capsid__${t}`).sort());
});

test("deploys, ships and force pushes are denied in both shells, and the admin connector is denied whole", () => {
  const denied = flag(driverArgs(), "--disallowedTools").split(",");
  assert.deepEqual(denied, DRIVER_DENIED);
  for (const shell of ["Bash", "PowerShell"]) {
    for (const command of [
      "npm run ship*", "wrangler deploy*", "npx wrangler deploy*", "git push --force*", "git -C * push --force*", "git -C * push * --force*",
      // The same acts spelled another way.
      "node scripts/deploy.mjs*", "npm run-script deploy*", "npm run-script ship*", "npx wrangler@* deploy*", "git push * +*", "git -C * push * +*",
    ]) {
      assert.ok(denied.includes(`${shell}(${command})`), `${shell}(${command}) is not denied`);
    }
  }
  assert.ok(denied.includes("mcp__claude_ai_Capsid"));
  for (const rule of denied) assert.equal(rule.includes(","), false, `${rule} would split the comma-separated flag`);
});

// the run log

test("the log is named by the Chicago day, not the UTC day", () => {
  // 04:00 Chicago in CDT is 09:00 UTC the same day, but 23:00 Chicago is the NEXT day
  // in UTC. A log named by the UTC day would file runs under the wrong date.
  assert.equal(chicagoDay(new Date("2026-09-12T04:30:00Z")), "2026-09-11", "23:30 Chicago is still the 11th locally");
  assert.equal(chicagoDay(new Date("2026-09-12T09:00:00Z")), "2026-09-12");
  assert.equal(logPath("2026-09-12"), "jobs/nightly-2026-09-12.md");
});

test("a failed run still renders a log, and the exit code is in it", () => {
  const body = renderLog("capsid", {
    exitCode: 1,
    output: "the driver could not reach the queue",
    started: "2026-09-12T09:00:00.000Z",
    finished: "2026-09-12T09:00:04.000Z",
  });
  assert.match(body, /# Nightly driver run, capsid/);
  assert.match(body, /claude exit code: 1 \(exited 1\)/);
  assert.match(body, /could not reach the queue/);
});

test("a long transcript is trimmed to its TAIL, because the end says how the run finished", () => {
  const output = `${"a".repeat(LOG_BUDGET + 500)}THE-END`;
  const body = renderLog("capsid", { exitCode: 0, output, started: "s", finished: "f" });
  assert.ok(body.includes("THE-END"), "the tail must survive trimming");
  assert.match(body, /earlier characters omitted/);
  assert.ok(body.length < output.length, "an unbounded transcript must not land in a document whole");
});

test("a short transcript is not trimmed and carries no omission note", () => {
  const body = renderLog("capsid", { exitCode: 0, output: "one job, done", started: "s", finished: "f" });
  assert.equal(/omitted/.test(body), false);
});

// failures are failures

type Call = string[];
/** A fake schtasks: `/Query` answers whether the task exists, every other verb
 *  answers with the code given for it. */
function fakeSchtasks(exists: boolean, codes: Record<string, number> = {}) {
  const calls: Call[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "/Query") return { code: exists ? 0 : 1, out: "" };
    return { code: codes[args[0]] ?? 0, out: `${args[0]} said no` };
  };
  return { run, calls };
}
const silent = () => {};

test("--namespace with no value is refused, rather than selecting every namespace", () => {
  assert.throws(() => parseArgs(["--install", "--namespace"]), /--namespace needs a value/);
  assert.throws(() => parseArgs(["--install", "--namespace", "--apply"]), /--namespace needs a value/);
  assert.equal(parseArgs(["--install", "--namespace", "capsid"]).namespace, "capsid");
});

test("REMOVE DOES NOT NEED THE KEY FILE: a task whose key was deleted can still be removed", () => {
  const { run, calls } = fakeSchtasks(true);
  const failed = manage("remove", ["capsid"], true, { run, hasKey: () => false, log: silent });
  assert.equal(failed, 0);
  assert.ok(calls.some((c) => c[0] === "/Delete"), "the task was not deleted because its key file is gone");
  // Install still needs it: the task it creates posts its log with that key.
  const second = fakeSchtasks(false);
  manage("install", ["capsid"], true, { run: second.run, hasKey: () => false, log: silent });
  assert.equal(second.calls.some((c) => c[0] === "/Create"), false);
});

test("a failed create and a failed delete are each counted as a failure", () => {
  const create = fakeSchtasks(false, { "/Create": 1 });
  assert.equal(manage("install", ["capsid"], true, { run: create.run, hasKey: () => true, log: silent }), 1);

  const del = fakeSchtasks(true, { "/Delete": 1 });
  assert.equal(manage("remove", ["capsid", "foxing"], true, { run: del.run, hasKey: () => true, log: silent }), 2);

  // The innocent case: a clean install counts nothing.
  const ok = fakeSchtasks(false);
  assert.equal(manage("install", ["capsid"], true, { run: ok.run, hasKey: () => true, log: silent }), 0);
});

test("the scheduled command names the capsid clone, whatever folder the install ran from", () => {
  const before = installCommand("foxing");
  const cwd = process.cwd();
  try {
    process.chdir(join(cwd, "test"));
    assert.equal(installCommand("foxing"), before);
  } finally {
    process.chdir(cwd);
  }
  assert.match(before, /capsid-mcp[\\/]scripts[\\/]schedule-drivers\.mjs/);
});

test("a log the write tool REFUSED is not reported as posted", async () => {
  // The run log goes through the shared client, which throws on isError; runOne's
  // catch then prints the log instead of "posted".
  const impl = (async (_url: string, init: { body: string }) => {
    const m = JSON.parse(init.body) as { id?: number; method: string };
    const result = m.method === "tools/call" ? { isError: true, content: [{ type: "text", text: "no write grant" }] } : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  }) as unknown as typeof fetch;
  const client = capsidClient("https://capsid.example.com", "k", "test", impl);
  await assert.rejects(postLog("capsid", client, "body", "2026-09-25"), /write refused: no write grant/);
});
