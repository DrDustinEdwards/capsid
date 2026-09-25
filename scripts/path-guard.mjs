// THE DETERMINISTIC PATH GUARD, FOR THE SUBSCRIPTION-MODE DRIVER.
//
// In API mode the Worker runs pathMonitor() over an attempt's changed paths and reverts
// anything touching a test, a workflow, a lockfile or the loop's own source.
// Subscription mode never enters that code, so this is the same guard, runnable from a
// clone with no install. It carries NO copy of the pattern list: the driver fetches
// `protected_paths` from improve_status and passes it in, so the rules it applies are
// the rules the Worker holds.
//
// Usage, from the driver, run inside the clone being checked:
//
//   node scripts/path-guard.mjs protected.json <base> HEAD
//
// protected.json is the `protected_paths` array improve_status returned, verbatim. Exit
// 0 means no changed path is protected. Exit 1 means at least one is, and every hit is
// printed with the reason the Worker gives for it. Exit 2 means the guard could not run,
// which is NOT a pass.
//
// The guard runs the diff itself rather than reading a file the driver wrote: a
// redirected diff can miss a rename's old path, C-quote a non-ASCII path, be empty
// after a failed diff, or be UTF-16LE from PowerShell 5.1 (see changedPaths).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Returns the hits, or throws. AN EMPTY LIST IS A REFUSAL, not an all-clear: a driver
// whose improve_status call failed, or which passed the wrong field, must not conclude
// that nothing is protected.
export function checkPaths(served, paths) {
  if (!Array.isArray(served) || served.length === 0) {
    throw new Error(
      "no protected paths were supplied. Pass the `protected_paths` array from improve_status; an empty list is a failed fetch, not an all-clear."
    );
  }
  const patterns = served.map((entry) => {
    if (typeof entry?.pattern !== "string") throw new Error(`a protected path entry carries no pattern: ${JSON.stringify(entry)}`);
    return { regexp: new RegExp(entry.pattern, entry.flags ?? ""), why: entry.why ?? "protected" };
  });
  const hits = [];
  for (const path of paths) {
    for (const { regexp, why } of patterns) {
      if (regexp.test(path)) {
        hits.push({ path, why });
        break;
      }
    }
  }
  return hits;
}

// The paths changed between two commits, from git directly, or throws.
//
// --no-renames lists a rename as a delete of the old path plus an add of the new one,
// so both are checked. -z prints paths raw and NUL-terminated, never C-quoted. No
// shell is involved. A git failure throws, and so does an empty list: an attempt that
// changed nothing has nothing to push, and an empty list is more often a wrong ref.
// A path that still starts with a double quote is refused rather than matched, since
// no pattern anchored at the start of a path can see past the quote.
export function changedPaths(base, head, cwd = process.cwd()) {
  for (const ref of [base, head]) {
    if (typeof ref !== "string" || ref === "") throw new Error("a base and a head ref are required");
    if (ref.startsWith("-")) throw new Error(`the ref ${JSON.stringify(ref)} starts with "-" and would be read as an option`);
  }
  let out;
  try {
    out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}..${head}`, "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String(e.stderr).trim() : "";
    throw new Error(`git diff failed for ${base}..${head}: ${stderr || (e instanceof Error ? e.message : String(e))}`);
  }
  const paths = out.split("\0").filter((p) => p !== "");
  if (paths.length === 0) {
    throw new Error(`git diff lists no changed paths for ${base}..${head}. Check the refs; an empty list is not a pass.`);
  }
  const quoted = paths.filter((p) => p.startsWith('"'));
  if (quoted.length > 0) {
    throw new Error(`refusing path(s) that start with a double quote: ${quoted.map((p) => JSON.stringify(p)).join(", ")}`);
  }
  return paths;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (invokedDirectly) {
  const [servedFile, base, head] = process.argv.slice(2);
  if (!servedFile || !base || !head) {
    console.error("usage: node scripts/path-guard.mjs <protected_paths.json> <base> <head>");
    process.exit(2);
  }
  try {
    const served = JSON.parse(readFileSync(servedFile, "utf8"));
    const paths = changedPaths(base, head);
    const hits = checkPaths(Array.isArray(served) ? served : served.protected_paths, paths);
    if (hits.length === 0) {
      console.log(`path guard: ${paths.length} changed path(s), none protected`);
      process.exit(0);
    }
    for (const hit of hits) console.error(`PROTECTED ${hit.path} (${hit.why})`);
    console.error(`path guard REFUSED this attempt: ${hits.length} protected path(s). An attempt may not edit what measures it.`);
    process.exit(1);
  } catch (e) {
    console.error(`path guard could not run: ${e.message}`);
    process.exit(2);
  }
}
