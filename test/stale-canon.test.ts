import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeFromFiles,
  citesPath,
  instant,
  MAX_FLAGS,
  MAX_NAMESPACES,
  namespacesThisPass,
  MAX_PATHS_PER_PR,
  newMerges,
  parseMemory,
  pruneMemory,
  staleCanonDoc,
  staleCanonFindings,
  staleCanonFingerprint,
  staleCanonFlags,
  type CanonDoc,
  type MergedChange,
} from "../src/stale-canon.ts";
import { findingClass, owningCheck, WATCHER_CHECKS } from "../src/watcher-checks.ts";

// Stale canon after a merge (improvement item 23, src/stale-canon.ts): the pure matching.
// Fake data throughout: namespace "sample", repo paths of a made-up app.

const NOW = new Date("2026-10-18T12:00:00Z");

const merge = (number: number, merged_at: string, over: Partial<MergedChange> = {}): MergedChange => ({
  number,
  url: `https://github.com/example/sample/pull/${number}`,
  merged_at,
  removed: [],
  changed: [],
  added: [],
  partial: null,
  ...over,
});

const doc = (path: string, over: Partial<CanonDoc> = {}): CanonDoc => ({
  path,
  type: "note",
  status: "published",
  updated_at: "2026-10-01 09:00:00",
  body: "",
  ...over,
});

test("changeFromFiles: a deletion, a rename, a modification and an addition land in their own lists", () => {
  const change = changeFromFiles([
    { filename: "src/admin/shell.ts", status: "removed" },
    { filename: "src/admin/layout.ts", previous_filename: "src/admin/app-shell.ts", status: "renamed" },
    { filename: "ROUTES.md", status: "modified" },
    { filename: "src/admin/new.ts", status: "added" },
  ]);
  assert.deepEqual(change.removed, [
    { path: "src/admin/shell.ts", to: null },
    { path: "src/admin/app-shell.ts", to: "src/admin/layout.ts" },
  ]);
  assert.deepEqual(change.changed, ["ROUTES.md"]);
  assert.deepEqual(change.added, ["src/admin/layout.ts", "src/admin/new.ts"]);
  assert.equal(change.partial, null);
});

test("changeFromFiles: a list over the cap is kept cut and says so", () => {
  const rows = Array.from({ length: MAX_PATHS_PER_PR + 1 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "removed" }));
  const change = changeFromFiles(rows);
  assert.equal(change.removed.length, MAX_PATHS_PER_PR);
  assert.match(change.partial ?? "", /more than/);
});

test("citesPath: a whole path matches, a longer or nested path does not", () => {
  assert.ok(citesPath("The admin reuses `src/admin/shell.ts`.", "src/admin/shell.ts"));
  assert.ok(citesPath("see src/admin/shell.ts, then", "src/admin/shell.ts"));
  assert.ok(citesPath("ROUTES.md says so", "ROUTES.md"));
  assert.ok(!citesPath("src/admin/shell.tsx", "src/admin/shell.ts"));
  assert.ok(!citesPath("src/admin/shell.ts.bak", "src/admin/shell.ts"));
  assert.ok(!citesPath("lib/src/admin/shell.ts", "src/admin/shell.ts"));
  assert.ok(!citesPath("docs/ROUTES.md", "ROUTES.md"));
  assert.ok(!citesPath("src/admin/shell", "src/admin/shell.ts"));
  // A path with no slash and no dot is a word in prose.
  assert.ok(!citesPath("The Makefile target", "Makefile"));
  // Regex characters in a path are literal.
  assert.ok(citesPath("app/(admin)/page.tsx is the route", "app/(admin)/page.tsx"));
  assert.ok(!citesPath("app/xadminx/page.tsx", "app/(admin)/page.tsx"));
});

test("staleCanonDoc: canon paths and canon types, never dated or retired documents", () => {
  assert.ok(staleCanonDoc("sample", { path: "core.md", type: "note", status: "published" }));
  assert.ok(staleCanonDoc("sample", { path: "decisions.md", type: null, status: null }));
  assert.ok(staleCanonDoc("sample", { path: "ROUTES.md", type: "reference", status: "published" }));
  assert.ok(staleCanonDoc("sample", { path: "DESIGN.md", type: "spec", status: "active" }));
  assert.ok(!staleCanonDoc("sample", { path: "notes/today.md", type: "episodic", status: "published" }));
  assert.ok(!staleCanonDoc("sample", { path: "archive/decisions.md", type: "decision", status: "published" }));
  assert.ok(!staleCanonDoc("sample", { path: "research/design-x.md", type: "spec", status: "published" }));
  assert.ok(!staleCanonDoc("sample", { path: "DESIGN.md", type: "spec", status: "superseded" }));
});

test("instant: a D1 datetime is UTC", () => {
  assert.equal(instant("2026-10-18 09:00:00"), Date.parse("2026-10-18T09:00:00Z"));
  assert.equal(instant("2026-10-18T09:00:00Z"), Date.parse("2026-10-18T09:00:00Z"));
});

test("PLANT: a canon document citing a file the merge deleted is flagged, naming the document, the PR and the path", () => {
  const flags = staleCanonFlags(
    "sample",
    [merge(41, "2026-10-10T10:00:00Z", { removed: [{ path: "src/admin/shell.ts", to: null }] })],
    [doc("ROUTES.md", { type: "reference", body: "The admin reuses the app shell in src/admin/shell.ts." }), doc("notes/log.md", { type: "episodic", body: "src/admin/shell.ts" })],
    []
  );
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.doc, "ROUTES.md");
  assert.equal(flags[0]!.pr, 41);
  assert.deepEqual(flags[0]!.cited, [{ path: "src/admin/shell.ts", how: "deleted", to: null, via: "body" }]);
});

test("a rename is flagged by body or by a typed edge to the old path", () => {
  const flags = staleCanonFlags(
    "sample",
    [merge(42, "2026-10-10T10:00:00Z", { removed: [{ path: "src/admin/app-shell.ts", to: "src/admin/layout.ts" }], added: ["src/admin/layout.ts"] })],
    [doc("core.md", { body: "no path here" }), doc("DESIGN.md", { type: "spec", body: "see src/admin/app-shell.ts" })],
    [{ from_path: "core.md", type: "references", to_path: "src/admin/app-shell.ts" }]
  );
  assert.deepEqual(
    flags.map((f) => [f.doc, f.cited[0]!.via, f.cited[0]!.how, f.cited[0]!.to]),
    [
      ["core.md", "edge", "renamed", "src/admin/layout.ts"],
      ["DESIGN.md", "body", "renamed", "src/admin/layout.ts"],
    ]
  );
});

test("a modified file flags a canon document only through a typed edge, never by body", () => {
  const flags = staleCanonFlags(
    "sample",
    [merge(43, "2026-10-10T10:00:00Z", { changed: ["src/routes.ts"] })],
    [
      doc("ROUTES.md", { type: "reference", body: "src/routes.ts" }),
      doc("DESIGN.md", { type: "spec", body: "" }),
      doc("notes/x.md", { type: "note", body: "" }),
    ],
    [
      { from_path: "DESIGN.md", type: "references", to_path: "src/routes.ts" },
      { from_path: "notes/x.md", type: "references", to_path: "src/routes.ts" },
    ]
  );
  assert.deepEqual(flags.map((f) => [f.doc, f.cited[0]!.how, f.cited[0]!.via]), [["DESIGN.md", "changed", "edge"]]);
});

test("a document written after the merge is not flagged, so writing it clears the flag", () => {
  const prs = [merge(44, "2026-10-10T10:00:00Z", { removed: [{ path: "src/admin/shell.ts", to: null }] })];
  const body = "src/admin/shell.ts";
  assert.equal(staleCanonFlags("sample", prs, [doc("core.md", { body, updated_at: "2026-10-10 10:00:01" })], []).length, 0);
  assert.equal(staleCanonFlags("sample", prs, [doc("core.md", { body, updated_at: "2026-10-10 09:59:59" })], []).length, 1);
  // The citation gone clears it too.
  assert.equal(staleCanonFlags("sample", prs, [doc("core.md", { body: "the shell is gone" })], []).length, 0);
});

test("a path a later merge brought back is not stale", () => {
  const flags = staleCanonFlags(
    "sample",
    [
      merge(46, "2026-10-12T10:00:00Z", { added: ["src/admin/shell.ts"] }),
      merge(45, "2026-10-10T10:00:00Z", { removed: [{ path: "src/admin/shell.ts", to: null }] }),
    ],
    [doc("core.md", { body: "src/admin/shell.ts" })],
    []
  );
  assert.equal(flags.length, 0);
});

test("one flag per document and pull request, naming every cited path", () => {
  const flags = staleCanonFlags(
    "sample",
    [merge(47, "2026-10-10T10:00:00Z", { removed: [{ path: "a/one.ts", to: null }, { path: "a/two.ts", to: null }] })],
    [doc("core.md", { body: "a/one.ts and a/two.ts" })],
    []
  );
  assert.equal(flags.length, 1);
  assert.deepEqual(flags[0]!.cited.map((c) => c.path), ["a/one.ts", "a/two.ts"]);
});

test("findings: digest class, owned by the stale canon check, a stable fingerprint, and the headline names doc, PR and path", () => {
  const flags = staleCanonFlags(
    "sample",
    [merge(48, "2026-10-10T10:00:00Z", { removed: [{ path: "src/admin/shell.ts", to: null }] })],
    [doc("ROUTES.md", { type: "reference", body: "src/admin/shell.ts" })],
    []
  );
  const [f] = staleCanonFindings(flags);
  assert.ok(f);
  assert.equal(f.fingerprint, staleCanonFingerprint({ namespace: "sample", doc: "ROUTES.md", pr: 48 }));
  assert.match(f.fingerprint, /^stale-canon-sample-48-[0-9a-f]{8}$/);
  assert.notEqual(f.fingerprint, staleCanonFingerprint({ namespace: "sample", doc: "DESIGN.md", pr: 48 }));
  assert.match(f.title, /sample\/ROUTES\.md may be stale after PR #48: it cites src\/admin\/shell\.ts, which the PR deleted/);
  assert.ok(f.title.endsWith(`[${f.fingerprint}]`));
  assert.ok(f.evidence?.some((l) => l.includes("https://github.com/example/sample/pull/48")));
  assert.equal(findingClass(f.fingerprint), "digest");
  assert.equal(owningCheck(f.fingerprint), "stale canon");
  assert.ok((WATCHER_CHECKS as readonly string[]).includes("stale canon"));
});

test("findings are capped at MAX_FLAGS, in a stable order", () => {
  const flags = Array.from({ length: MAX_FLAGS + 5 }, (_, i) => ({
    namespace: "sample",
    doc: `d${String(i).padStart(3, "0")}.md`,
    pr: 1,
    url: "https://github.com/example/sample/pull/1",
    merged_at: "2026-10-10T10:00:00Z",
    cited: [{ path: "a/b.ts", how: "deleted" as const, to: null, via: "body" as const }],
    partial: null,
  }));
  const a = staleCanonFindings(flags).map((f) => f.fingerprint);
  const b = staleCanonFindings([...flags].reverse()).map((f) => f.fingerprint);
  assert.equal(a.length, MAX_FLAGS);
  assert.deepEqual(a, b);
});

test("newMerges: merged into the default branch, inside the window, not remembered, oldest first", () => {
  const base = { ref: "main", repo: { default_branch: "main" } };
  const listed = [
    { number: 5, html_url: "u5", merged_at: "2026-10-17T10:00:00Z", base },
    { number: 4, html_url: "u4", merged_at: "2026-10-16T10:00:00Z", base },
    { number: 3, html_url: "u3", merged_at: null, base },
    { number: 2, html_url: "u2", merged_at: "2026-10-15T10:00:00Z", base: { ref: "feature", repo: { default_branch: "main" } } },
    { number: 1, html_url: "u1", merged_at: "2026-08-01T10:00:00Z", base },
    { number: 6, html_url: "u6", merged_at: "2026-10-18T10:00:00Z", base },
  ];
  assert.deepEqual(newMerges(listed, new Set([6]), NOW).map((p) => p.number), [4, 5]);
});

test("memory: absent is empty, damage is reported, old merges are pruned", () => {
  assert.deepEqual(parseMemory(null), { memory: {} });
  assert.ok("problem" in parseMemory("{"));
  assert.ok("problem" in parseMemory("[]"));
  assert.ok("problem" in parseMemory(JSON.stringify({ sample: { prs: [] } })));
  const kept = pruneMemory(
    { sample: { repo: "example/sample", prs: [merge(1, "2026-08-01T00:00:00Z"), merge(2, "2026-10-17T00:00:00Z")] }, other: { repo: "example/other", prs: [merge(3, "2026-08-01T00:00:00Z")] } },
    NOW
  );
  assert.deepEqual(Object.keys(kept), ["sample"]);
  assert.deepEqual(kept.sample!.prs.map((p) => p.number), [2]);
});

test("PLANT: a namespace list past the cap forgets nothing and is not complete", () => {
  const rows = Array.from({ length: MAX_NAMESPACES + 1 }, (_, i) => `ns-${String(i).padStart(2, "0")}`);
  const last = rows[MAX_NAMESPACES];
  const memory = { [last]: { repo: "example/sample", prs: [] } };
  const capped = namespacesThisPass(rows, memory);
  assert.equal(capped.capped, true);
  assert.equal(capped.listed.length, MAX_NAMESPACES);
  assert.ok(memory[last], "a namespace past the cap, still mapped, was forgotten");

  // Under the cap the list is whole, so an unmapped namespace is forgotten.
  const gone = { gone: { repo: "example/gone", prs: [] } };
  assert.equal(namespacesThisPass(["sample"], gone).capped, false);
  assert.equal(gone.gone, undefined);
});
