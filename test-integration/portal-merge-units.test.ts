import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_KEY, SUSPENDED_KEY } from "../src/merge-units";
import { readMergeUnits } from "../src/portal-merge-units";

// GET /portal/api/merge-units against a real KV: the suspended units as the tick reads them and
// the units tick's proposals, without a promote for a unit suspended since the report.

const GENERATED = "2026-11-06T04:00:00.000Z";

afterEach(async () => {
  await env.APP_KV.delete(SUSPENDED_KEY);
  await env.APP_KV.delete(REPORT_KEY);
});

describe("the Merge units panel's read", () => {
  it("serves the suspensions and proposals, and drops a promote for a suspended unit", async () => {
    await env.APP_KV.put(
      SUSPENDED_KEY,
      JSON.stringify([
        {
          unit: "sample/docs",
          since: GENERATED,
          reason: "example/sample#3 merged unattended and was rolled back",
        },
      ]),
    );
    await env.APP_KV.put(
      REPORT_KEY,
      JSON.stringify({
        generated: GENERATED,
        suspended: [],
        unplaced: [],
        proposals: [
          {
            kind: "demote",
            unit: "sample/docs",
            title: "Remove sample docs from auto",
            evidence: {},
          },
          {
            kind: "promote",
            unit: "sample/docs",
            title: "Promote sample docs to auto",
            evidence: {},
          },
          {
            kind: "promote",
            unit: "sample/tests",
            title: "Promote sample tests to auto",
            evidence: {},
          },
        ],
      }),
    );
    const units = await readMergeUnits(env.APP_KV);
    expect(units.generated).toBe(GENERATED);
    expect(units.suspended.map((s) => s.unit)).toEqual(["sample/docs"]);
    expect(units.proposals.map((p) => `${p.kind} ${p.unit}`)).toEqual([
      "demote sample/docs",
      "promote sample/tests",
    ]);
  });
});
