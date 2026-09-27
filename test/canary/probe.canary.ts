import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

// The seat-session canary probe (capsid/research/design-seat-session-hardening.md,
// PR 5). It is the planted code the design asks for: it tries what a hostile test file
// run through `npm test` would try, and reports each attempt as a boolean.
//
// It never prints a value it reads. Actions logs on a public repo are public, so the
// report is true and false only, on one line starting CANARY_RESULT.
//
// It never fails. The verdict is the caller's: the hardened run (a real seat-started
// session) expects every exposure false and the allowed paths true, and the weakened
// workflow (seat-session-canary-weakened.yml) expects every exposure true, which is
// what shows these probes can see an exposure at all.
//
// Not matched by `npm test`'s glob (test/*.test.ts). The session runs it with
// `npm test -- test/canary/probe.canary.ts`, which adds it to the suite.

const TIMEOUT_MS = 8000;

function attempt(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    // A refused read, write or spawn is the answer "no", not an error to report.
    return false;
  }
}

async function reaches(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

// curl honours the proxy variables the sandbox sets, where Node's fetch does not, so
// the two answer different questions: a direct connection, and one through the proxy.
function curlReaches(url: string): boolean {
  const r = spawnSync("curl", ["-sS", "-o", "/dev/null", "-m", String(TIMEOUT_MS / 1000), url], { stdio: "ignore" });
  return r.status === 0;
}

function socketConnects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const CREDENTIAL_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "DEFAULT_WORKFLOW_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

// Any process's environment this code can read that carries a credential variable.
// A PID namespace or /proc hidepid answers false by not showing the process at all.
function procEnvironLeaks(): boolean {
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    const environ = attempt(() => {
      const text = readFileSync(`/proc/${pid}/environ`, "latin1");
      return CREDENTIAL_NAMES.some((name) => text.includes(`${name}=`) && !text.includes(`${name}=\0`));
    });
    if (environ) return true;
  }
  return false;
}

function keyFileReadable(): boolean {
  const dirs = [process.env.RUNNER_TEMP, "/home/runner/work/_temp"].filter((d): d is string => Boolean(d));
  return dirs.some((dir) => attempt(() => readFileSync(join(dir, "capsid-mcp.json"), "utf8").length > 0));
}

function gitConfigWritable(): boolean {
  return attempt(() => {
    closeSync(openSync(join(process.cwd(), ".git", "config"), "a"));
    return true;
  });
}

function gitHooksWritable(): boolean {
  const planted = join(process.cwd(), ".git", "hooks", "canary-probe");
  return attempt(() => {
    writeFileSync(planted, "#!/bin/sh\nexit 0\n");
    unlinkSync(planted);
    return true;
  });
}

test("canary probe", async () => {
  // Typed so that a probe reporting anything but a boolean fails the typecheck: a
  // string here could be a value the probe read.
  const result: Record<string, boolean> = {
    // Network: a host no allowlist names, by fetch, by curl through any proxy, and by a
    // raw socket to an address; then the one host Bash is allowed, through the proxy.
    example_fetch: await reaches("https://example.com"),
    example_curl: curlReaches("https://example.com"),
    raw_socket_1111: await socketConnects("1.1.1.1", 443),
    github_curl: curlReaches("https://github.com"),
    // Credentials.
    oauth_token_in_env: attempt(() => Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)),
    github_token_in_env: attempt(() => ["GITHUB_TOKEN", "GH_TOKEN", "DEFAULT_WORKFLOW_TOKEN"].some((n) => Boolean(process.env[n]))),
    oidc_request_in_env: attempt(() => Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)),
    proc_environ_leaks: attempt(procEnvironLeaks),
    key_file_readable: keyFileReadable(),
    // Git config the session must not be able to change.
    git_config_writable: gitConfigWritable(),
    git_hooks_writable: gitHooksWritable(),
    // Privilege.
    sudo_available: attempt(() => spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0),
    docker_reachable: attempt(() => existsSync("/var/run/docker.sock") || existsSync("/run/containerd/containerd.sock")),
  };
  console.log(`CANARY_RESULT ${JSON.stringify(result)}`);
});
