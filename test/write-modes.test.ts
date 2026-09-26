import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleBody, narrowWrite } from "../src/write-modes.ts";

// The anchor guard must refuse rather than corrupt, and repeated appends must not
// mangle spacing.

const existing = { exists: true, priorBody: "# Doc\n\nFirst section.\n" };

test("replace needs both title and body", () => {
  assert.match(
    (assembleBody({ mode: "replace", exists: false, priorBody: null, body: "x" }) as { error: string }).error,
    /needs both title and body/
  );
  assert.match(
    (assembleBody({ mode: "replace", exists: false, priorBody: null, title: "T" }) as { error: string }).error,
    /needs both title and body/
  );
  assert.deepEqual(assembleBody({ mode: "replace", exists: false, priorBody: null, title: "T", body: "B" }), {
    body: "B",
  });
});

test("append, patch and meta refuse a document that does not exist", () => {
  for (const mode of ["append", "patch", "meta"] as const) {
    const r = assembleBody({ mode, exists: false, priorBody: null, find: "a", replace_with: "b" });
    assert.match((r as { error: string }).error, /does not exist/);
  }
});

test("meta leaves the body byte-identical", () => {
  // Closing a task or fixing a mistyped document must not cost a full-body
  // retranscription.
  const body = "# Doc\n\nFirst section.\n";
  const r = assembleBody({ exists: true, priorBody: body, mode: "meta" });
  assert.deepEqual(r, { body });
});

test("meta refuses body, find and replace_with", () => {
  assert.match(
    (assembleBody({ ...existing, mode: "meta", body: "x" }) as { error: string }).error,
    /does not take body/
  );
  assert.match(
    (assembleBody({ ...existing, mode: "meta", find: "a", replace_with: "b" }) as { error: string }).error,
    /belong to mode 'patch'/
  );
});

test("meta preserves an empty body rather than inventing one", () => {
  const r = assembleBody({ exists: true, priorBody: null, mode: "meta" });
  assert.deepEqual(r, { body: "" });
});

test("append puts exactly one blank line between the old body and the addition", () => {
  const r = assembleBody({ ...existing, mode: "append", body: "Second section.\n" });
  assert.deepEqual(r, { body: "# Doc\n\nFirst section.\n\nSecond section.\n" });
});

test("append normalizes whatever trailing and leading whitespace it is handed", () => {
  // The stored body ends with several newlines and the caller also leads with
  // one. Naive concatenation gives four blank lines.
  const r = assembleBody({
    exists: true,
    priorBody: "# Doc\n\nFirst.\n\n\n",
    mode: "append",
    body: "\n\nSecond.\n",
  });
  assert.deepEqual(r, { body: "# Doc\n\nFirst.\n\nSecond.\n" });
});

test("append is idempotent in spacing across repeated appends", () => {
  let body = "# Doc\n";
  for (const line of ["One.", "Two.", "Three."]) {
    const r = assembleBody({ exists: true, priorBody: body, mode: "append", body: line });
    body = (r as { body: string }).body;
  }
  assert.equal(body, "# Doc\n\nOne.\n\nTwo.\n\nThree.");
  assert.doesNotMatch(body, /\n{3,}/);
});

test("append rejects patch arguments", () => {
  const r = assembleBody({ ...existing, mode: "append", body: "x", find: "a", replace_with: "b" });
  assert.match((r as { error: string }).error, /belong to mode 'patch'/);
});

test("patch replaces a unique anchor", () => {
  const r = assembleBody({ ...existing, mode: "patch", find: "First section.", replace_with: "First section, revised." });
  assert.deepEqual(r, { body: "# Doc\n\nFirst section, revised.\n" });
});

test("patch REFUSES a missing anchor rather than writing anything", () => {
  // A missed anchor must not corrupt the body.
  const r = assembleBody({ ...existing, mode: "patch", find: "Nonexistent.", replace_with: "x" });
  assert.match((r as { error: string }).error, /anchor not found/);
  assert.ok(!("body" in r));
});

test("patch REFUSES an ambiguous anchor and says how many times it matched", () => {
  const r = assembleBody({
    exists: true,
    priorBody: "alpha\nbeta\nalpha\n",
    mode: "patch",
    find: "alpha",
    replace_with: "gamma",
  });
  assert.match((r as { error: string }).error, /occurs 2 times/);
  assert.ok(!("body" in r));
});

test("patch names CRLF as the usual cause of a missed anchor", () => {
  // A caller whose find fails on CRLF should be told the likely cause.
  const r = assembleBody({
    exists: true,
    priorBody: "line one\r\nline two\r\n",
    mode: "patch",
    find: "line one\nline two",
    replace_with: "x",
  });
  assert.match((r as { error: string }).error, /CRLF/);
});

test("patch refuses an empty anchor", () => {
  const r = assembleBody({ ...existing, mode: "patch", find: "", replace_with: "x" });
  assert.match((r as { error: string }).error, /non-empty find/);
});

test("patch rejects body", () => {
  const r = assembleBody({ ...existing, mode: "patch", find: "a", replace_with: "b", body: "c" });
  assert.match((r as { error: string }).error, /not body/);
});

test("patch replaces only the single occurrence, even when replace_with contains the anchor", () => {
  // A naive String.replace with a global flag, or a caller looping, would run
  // away here. Confirms exactly one substitution.
  const r = assembleBody({
    exists: true,
    priorBody: "keep A end",
    mode: "patch",
    find: "A",
    replace_with: "A and more A",
  });
  assert.deepEqual(r, { body: "keep A and more A end" });
});

test("patch treats find as a literal, not a regex", () => {
  // "$&" and "." and "*" are all regex-significant. find must match bytes.
  const r = assembleBody({
    exists: true,
    priorBody: "cost is $5.00 (approx)",
    mode: "patch",
    find: "$5.00 (approx)",
    replace_with: "$6.00 (exact)",
  });
  assert.deepEqual(r, { body: "cost is $6.00 (exact)" });
});

// The replacement is literal, not a substitution pattern. String.replace reads $
// sequences in the replacement even when the pattern is a plain string.

test("patch treats every $ substitution sequence in replace_with literally", () => {
  const cases: Array<[string, string]> = [
    ["$&", "$&"],
    ["$`", "$`"],
    ["$'", "$'"],
    ["$$", "$$"],
    ["a $& b $` c $' d $$ e", "a $& b $` c $' d $$ e"],
    ["$1 $2 $<name>", "$1 $2 $<name>"],
  ];
  for (const [replacement, expected] of cases) {
    const result = assembleBody({
      mode: "patch",
      exists: true,
      priorBody: "before ANCHOR after",
      find: "ANCHOR",
      replace_with: replacement,
    });
    assert.deepEqual(result, { body: `before ${expected} after` }, `replace_with ${JSON.stringify(replacement)} was rewritten`);
  }
});

test("patch keeps a realistic canon fragment byte-exact", () => {
  // An ordinary dollar amount does not trigger the bug: only $&, $`, $', $$ and
  // $1..$99 mean anything to String.replace, so a fixture using $5 would pass
  // against broken code. The triggers below are realistic: $'000 for thousands,
  // $$ as a shell PID, and $& in a document describing this defect.
  const NL = String.fromCharCode(10);
  const before = "# Costs" + NL + NL;
  const after = NL + NL + "Ruled 2026-08-13.";
  const replacement =
    "Storage runs to $'000s a year at $5/month per seat. The prune logs $$ and the " +
    "old patch path rewrote $& into the matched text, which is why this line exists.";
  const result = assembleBody({
    mode: "patch",
    exists: true,
    priorBody: before + "PLACEHOLDER" + after,
    find: "PLACEHOLDER",
    replace_with: replacement,
  });
  // Expected is CONCATENATED, not produced by any replace(), so the assertion
  // cannot inherit the behaviour it is checking.
  assert.deepEqual(result, { body: before + replacement + after });
  assert.ok("body" in result);
  assert.ok(result.body.includes("$'000s"));
  assert.ok(result.body.includes("$$ and the"));
  assert.ok(result.body.includes("rewrote $& into"));
  // Nothing from elsewhere in the document was pulled into the replacement.
  assert.equal(result.body.split("Ruled 2026-08-13.").length - 1, 1);
  assert.equal(result.body.split("# Costs").length - 1, 1);
});

// the narrow shape

// AssembleInput is a discriminated union: narrowWrite turns a loose wire request into
// it, and refuses a mode/field mismatch.

test("narrowWrite turns a loose wire request into the shape assembly needs", () => {
  const narrowed = narrowWrite({ mode: "patch", exists: true, priorBody: "hello world", find: "world", replace_with: "there" });
  assert.ok(!("error" in narrowed));
  assert.equal(narrowed.mode, "patch");
  // The fields are REQUIRED on the narrow type, which is what lets assembly stop
  // re-checking them.
  if (narrowed.mode === "patch") {
    assert.equal(narrowed.find, "world");
    assert.equal(narrowed.replace_with, "there");
  }
});

test("narrowWrite is where a mode/field mismatch is refused, not assembly", () => {
  // These must be refused rather than ignored. The wire is loose on purpose, so a
  // client can send them; the union only removes the shape after this point.
  const cases: Array<[Parameters<typeof narrowWrite>[0], RegExp]> = [
    [{ mode: "meta", exists: true, priorBody: "x", body: "nope" }, /does not take body/],
    [{ mode: "append", exists: true, priorBody: "x", body: "a", find: "f" }, /belong to mode 'patch', not 'append'/],
    [{ mode: "patch", exists: true, priorBody: "x", find: "f", replace_with: "r", body: "b" }, /takes find and replace_with, not body/],
    [{ mode: "replace", exists: true, priorBody: "x", body: "b" }, /needs both title and body/],
  ];
  for (const [req, expected] of cases) {
    const result = narrowWrite(req);
    assert.ok("error" in result, `${req.mode} accepted an illegal field combination`);
    assert.match(result.error, expected);
  }
});

test("error precedence did not move: replace reports its missing title before existence", () => {
  // mode 'replace' is checked BEFORE the existence test, so creating a document
  // without a title says so rather than "cannot replace a document that does not
  // exist". Every other mode reports the missing document first.
  const replace = narrowWrite({ mode: "replace", exists: false, priorBody: null, body: "b" });
  assert.ok("error" in replace);
  assert.match(replace.error, /needs both title and body/);

  const append = narrowWrite({ mode: "append", exists: false, priorBody: null });
  assert.ok("error" in append);
  assert.match(append.error, /cannot append a document that does not exist/);
});

