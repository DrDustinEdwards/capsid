import assert from "node:assert/strict";
import { test } from "node:test";
import { worthReviewer } from "../src/model-routing.ts";

const worth = (files: Parameters<typeof worthReviewer>[0]) => worthReviewer(files).level;

test("worthReviewer: a dependency bump, a backup document, a deleted screenshot, a prose deletion or a tsconfig edit is skipped", () => {
  for (const files of [
    [{ filename: "package-lock.json" }, { filename: "package.json" }],
    [{ filename: "docs/backups.md" }],
    [{ filename: "docs/img/portal.png", status: "removed" }],
    [{ filename: "docs/old-plan.md", deletions: 350 }],
    [{ filename: "tsconfig.test.json" }],
    [{ filename: "test/restore-drill.test.ts" }, { filename: "test-integration/backup.test.ts" }],
    [{ filename: "dashboard/src/views/Backups.tsx" }],
  ]) {
    assert.equal(worth(files), "skip", files.map((f) => f.filename).join(", "));
  }
  assert.equal(
    worth([{ filename: "dashboard/src/styles.css" }, { filename: "src/limits.ts" }]),
    "skip",
  );
});

test("worthReviewer: money, judges, guards, migrations, workflows and backup code are each worth a reviewer", () => {
  const cases: Array<[string, RegExp]> = [
    ["app/payments/charge.ts", /billing or payment code/],
    ["src/scope.ts", /isMoneyPath/],
    ["src/protected-paths.ts", /protected path list/],
    ["scripts/check-commit-trailers.mjs", /check script/],
    ["migrations/0040_x.sql", /migration/],
    [".github/workflows/ci.yml", /workflow, which holds CI's permissions/],
    ["src/store-guards.ts", /snapshot and audit guard/],
    ["src/tools/repo.ts", /guardedWrite/],
    ["src/tools/docs.ts", /pathMutation/],
    ["src/portal-auth.ts", /login or session check/],
    ["src/agents-admin.ts", /agent credentials/],
    ["src/backup.ts", /backup or restore code/],
    ["scripts/restore-table.mjs", /backup or restore code/],
  ];
  for (const [filename, why] of cases) {
    const verdict = worthReviewer([{ filename: "docs/notes.md" }, { filename }]);
    assert.equal(verdict.level, "worth", filename);
    assert.match(verdict.reasons.join(" "), why, filename);
  }
});

test("worthReviewer: a rename is judged under both names, and no files is unread, never skip", () => {
  assert.equal(
    worth([{ filename: "src/old-scope.ts", previous_filename: "src/scope.ts" }]),
    "worth",
  );
  const none = worthReviewer([]);
  assert.deepEqual([none.level, none.files_read], ["unread", 0]);
  assert.equal(worthReviewer([{ filename: "a.md" }, { filename: "b.md" }]).files_read, 2);
});

test("worthReviewer: a test or a document named like a guard is not the guard", () => {
  for (const filename of [
    "test/scope.test.ts",
    "docs/store-guards.md",
    "test/fixtures/migrations/0001.sql",
    "src/agents-schema.ts",
    "src/tools/docs-index.ts",
  ]) {
    assert.equal(worth([{ filename }]), "skip", filename);
  }
});
