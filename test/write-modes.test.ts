import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleBody, narrowWrite } from "../src/write-modes.ts";

// The anchor guard must refuse rather than corrupt, and repeated appends must not
// mangle spacing.

test("replace needs both title and body", () => {
  assert.match(
    (
      assembleBody({ mode: "replace", exists: false, priorBody: null, body: "x" }) as {
        error: string;
      }
    ).error,
    /needs both title and body/,
  );
  assert.match(
    (
      assembleBody({ mode: "replace", exists: false, priorBody: null, title: "T" }) as {
        error: string;
      }
    ).error,
    /needs both title and body/,
  );
  assert.deepEqual(
    assembleBody({ mode: "replace", exists: false, priorBody: null, title: "T", body: "B" }),
    {
      body: "B",
    },
  );
});

test("append, patch and meta refuse a document that does not exist", () => {
  for (const mode of ["append", "patch", "meta"] as const) {
    const r = assembleBody({ mode, exists: false, priorBody: null, find: "a", replace_with: "b" });
    assert.match((r as { error: string }).error, /does not exist/);
  }
});

test("meta preserves an empty body rather than inventing one", () => {
  const r = assembleBody({ exists: true, priorBody: null, mode: "meta" });
  assert.deepEqual(r, { body: "" });
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

test("patch REFUSES a missing, empty, ambiguous or CRLF-missed anchor and writes nothing", () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ["# Doc\n\nFirst section.\n", "Nonexistent.", "x", /anchor not found/],
    ["# Doc\n", "", "x", /non-empty find/],
    ["alpha\nbeta\nalpha\n", "alpha", "gamma", /occurs 2 times/],
    ["line one\r\nline two\r\n", "line one\nline two", "x", /CRLF/],
  ];
  for (const [priorBody, find, replace_with, expected] of cases) {
    const r = assembleBody({ exists: true, priorBody, mode: "patch", find, replace_with });
    assert.match((r as { error: string }).error, expected);
    assert.ok(!("body" in r));
  }
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
    assert.deepEqual(
      result,
      { body: `before ${expected} after` },
      `replace_with ${JSON.stringify(replacement)} was rewritten`,
    );
  }
});

// the narrow shape

// AssembleInput is a discriminated union: narrowWrite turns a loose wire request into
// it, and refuses a mode/field mismatch.

test("narrowWrite is where a mode/field mismatch is refused, not assembly", () => {
  // These must be refused rather than ignored. The wire is loose on purpose, so a
  // client can send them; the union only removes the shape after this point.
  const cases: Array<[Parameters<typeof narrowWrite>[0], RegExp]> = [
    [{ mode: "meta", exists: true, priorBody: "x", body: "nope" }, /does not take body/],
    [
      { mode: "append", exists: true, priorBody: "x", body: "a", find: "f" },
      /belong to mode 'patch', not 'append'/,
    ],
    [
      { mode: "patch", exists: true, priorBody: "x", find: "f", replace_with: "r", body: "b" },
      /takes find and replace_with, not body/,
    ],
    [{ mode: "replace", exists: true, priorBody: "x", body: "b" }, /needs both title and body/],
    [
      { mode: "meta", exists: true, priorBody: "x", find: "a", replace_with: "b" },
      /belong to mode 'patch'/,
    ],
  ];
  for (const [req, expected] of cases) {
    const result = narrowWrite(req);
    assert.ok("error" in result, `${req.mode} accepted an illegal field combination`);
    assert.match(result.error, expected);
  }
});
