---
name: reproduce-before-fixing
description: Use when a job reports that a guard, check or test is broken, before writing any fix: reproduce the failure, find the cause from the reproduction, and report red before and green after.
---

# Reproduce before fixing

A report that a guard is broken usually names a cause. Treat that cause as a
guess until you have seen the failure yourself.

## Steps

1. Build the smallest case that shows the reported failure: a planted violation,
   an input, or a commit. Confirm the plant landed by reading it back or diffing it.
2. Run the guard on the unfixed code and watch it give the wrong answer. If it
   gives the right answer, the report is wrong in some way. Find out how before
   writing any fix.
3. Find the cause from the reproduction, not from the report. Change one thing at
   a time until the wrong answer turns into the right one.
4. Commit the fix before planting against it, so undoing a plant cannot also undo
   the fix.
5. Run the same case again and watch it pass. Also run the innocent case, the one
   the guard must not flag, and watch it stay green.
6. In the report, state the cause and how you know it: which case, which run,
   red before and green after. If the reported cause was wrong, say so.

## Why

Fixing the reported cause without reproducing it can ship a fix for a defect that
does not exist and leave the real one in place. In the job this skill came from,
the report blamed barrel re-exports. The reproduction showed barrel re-exports
were already counted, and the real hole was a comment naming the planted export,
which made the guard treat that export as used.

## Not this skill

- A task with no claimed defect, such as a new feature. There is nothing to
  reproduce.
- A defect that cannot be reproduced locally, such as a live outage. Measure the
  live system first, and say that the reproduction was not local.
