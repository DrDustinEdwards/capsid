import { env } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addPackage,
  editPackage,
  readPackageConfig,
  removePackage,
} from "../src/ops-package-config";

// The npm package list against a real D1: configuration written like the sites', audited, and
// guarded by the revision it read.

const ACTOR = "access:admin@example.com";

beforeEach(async () => {
  await resetCapsidDb();
});

async function audit(action: string) {
  return env.DB.prepare("SELECT actor, params FROM audit_log WHERE action = ?1")
    .bind(action)
    .all<{ actor: string; params: string }>();
}

describe("configuration", () => {
  it("add, edit and remove are audited, and an edit or a removal names the revision it read", async () => {
    const added = await addPackage(env.DB, ACTOR, {
      name: "sample-pkg",
      repo: "example-org/sample-pkg",
      formerly: null,
    });
    expect(added.ok).toBe(true);
    expect(
      (await addPackage(env.DB, ACTOR, { name: "sample-pkg", repo: null, formerly: null })).ok,
      "a second add replaced the row",
    ).toBe(false);

    expect(
      (
        await editPackage(
          env.DB,
          ACTOR,
          { name: "sample-pkg", repo: "example-org/sample-pkg", formerly: "sample-old" },
          2,
        )
      ).ok,
      "a stale revision was accepted",
    ).toBe(false);
    const edited = await editPackage(
      env.DB,
      ACTOR,
      { name: "sample-pkg", repo: "example-org/sample-pkg", formerly: "sample-old" },
      1,
    );
    expect(edited.ok && edited.pkg).toMatchObject({ formerly: "sample-old", revision: 2 });

    expect((await removePackage(env.DB, ACTOR, "sample-pkg", 1)).ok).toBe(false);
    expect((await removePackage(env.DB, ACTOR, "sample-pkg", 2)).ok).toBe(true);
    expect(await readPackageConfig(env.DB)).toEqual([]);

    for (const action of ["ops-package-added", "ops-package-edited", "ops-package-removed"]) {
      const rows = (await audit(action)).results ?? [];
      expect(
        rows.map((r) => r.actor),
        action,
      ).toEqual([ACTOR]);
    }
    const removed = JSON.parse((await audit("ops-package-removed")).results![0].params);
    expect(removed.before).toMatchObject({ name: "sample-pkg", formerly: "sample-old" });
  });
});
