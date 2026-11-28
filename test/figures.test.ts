import assert from "node:assert/strict";
import { test } from "node:test";
import * as plot from "enarratio/plot";
import { heatThresholds, whoActed, writesRecent, writesYear } from "../src/figures.ts";
import { actorLabel, agentRows, heatRows } from "../src/portal-figures.ts";
import { threadsPerDay, topNames } from "../src/portal-board.ts";
import { unfence, externalFence } from "../src/provenance.ts";
import { lastDays } from "../src/trends-days.ts";

const NOW = new Date("2026-11-28T12:00:00.000Z");

function assertFigure(html: string | null, alt: RegExp): string {
  assert.ok(html, "no chart was drawn");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "a style attribute would break the Portal's CSP");
  assert.match(html, /<figure\b/);
  assert.match(html, /<table\b/, "no data table");
  assert.match(html, alt, "the text alternative does not state the finding");
  return html;
}

test("the year's writes lie flat, weeks across, and a phone gets the last 13 weeks", () => {
  const days = lastDays(NOW, 365);
  const counts = new Map(days.map((d, i) => [d, i % 7 === 0 ? 0 : (i * 13) % 90]));
  const year = assertFigure(
    writesYear(plot, days, counts),
    /Document writes per day over 52 weeks/,
  );
  assert.match(year, /the most \d+ on 20\d\d-\d\d-\d\d/);
  assert.match(
    year,
    /stroke-dasharray/,
    "a day with no write is an outlined cell, not the lightest step",
  );
  assertFigure(writesRecent(plot, days, counts), /over the last 13 weeks/);
  assert.equal(writesYear(plot, days, new Map()), null, "an empty year is no chart");
});

test("heat steps sit at the quintiles of the non-zero values, so one busy row cannot wash out the rest", () => {
  const values = [0, 0, 1, 2, 2, 3, 4, 5, 6, 8, 300];
  const t = heatThresholds(values)!;
  assert.ok(t[3] < 20, `the top step starts at ${t[3]}, not near 300`);
  assert.ok(
    t.every((v, i) => i === 0 || v > t[i - 1]!),
    "the steps ascend",
  );
  assert.equal(heatThresholds([0, 1, 1]), undefined, "too few values fall back to equal steps");
});

test("who acted: one row per actor and client, the rest as Other, wide by day and narrow by week", () => {
  const days = lastDays(NOW, 30);
  const rows = [
    ...days.map((day) => ({ day, actor: "system:reviewer", client: null, n: 210 })),
    ...days.map((day) => ({ day, actor: "access:admin@example.com", client: "Claude", n: 48 })),
    ...days.map((day) => ({ day, actor: "access:admin@example.com", client: null, n: 47 })),
    ...days.map((day) => ({ day, actor: "agent:watcher", client: null, n: 27 })),
    ...Array.from({ length: 12 }, (_, i) => ({
      day: days[i]!,
      actor: `agent:sample-${i}`,
      client: null,
      n: 1,
    })),
  ];
  const actors = agentRows(rows, days);
  assert.equal(actors[0]!.label, "reviewer (system)");
  assert.ok(actors.some((a) => a.label === "Project threads"));
  assert.ok(actors.some((a) => a.label === "You (Portal)"));
  assert.equal(actors.find((a) => a.actor === "agent:watcher")!.total, 27 * 30);
  const heat = heatRows(actors, days);
  assert.equal(heat.length, 11);
  assert.equal(heat[10]!.label, "Other");
  assertFigure(
    whoActed(plot, days, heat, "day"),
    /Actions per day over the last 30 days by 11 actors/,
  );
  assertFigure(whoActed(plot, days, heat, "week"), /Actions per week/);
  assert.equal(whoActed(plot, days, [], "day"), null);
});

test("threads are counted on the day each was first seen, the top five projects and Other", () => {
  const days = lastDays(NOW, 21);
  const rows = ["a", "a", "a", "b", "b", "c", "d", "e", "f", "g"].map((ns, i) => ({
    namespace: ns,
    first_seen: `${days[20 - (i % 3)]} 10:00:00`,
  }));
  rows.push({ namespace: "a", first_seen: "2026-01-01 10:00:00" });
  const out = threadsPerDay(rows, days);
  assert.equal(out.total, 10, "a thread first seen before the window is not counted");
  assert.deepEqual(out.projects, ["a", "b", "c", "d", "e", "Other"]);
  assert.equal(out.per_day.length, 21 * 6);
  assert.equal(
    out.per_day.filter((r) => r.project === "Other").reduce((n, r) => n + r.threads, 0),
    2,
  );
  assert.deepEqual(
    topNames(
      new Map([
        ["x", 1],
        ["y", 3],
      ]),
      1,
    ),
    ["y"],
  );
});

test("actor labels: threads and the Portal part, agents by name", () => {
  assert.equal(actorLabel("access:admin@example.com", "Claude"), "Project threads");
  assert.equal(actorLabel("access:admin@example.com", ""), "You (Portal)");
  assert.equal(actorLabel("agent:watcher", null), "watcher");
  assert.equal(actorLabel("capsid:push", null), "push (capsid)");
});

test("unfence gives back the text a fence wraps, and leaves other text alone", () => {
  const text = "Fix the ~~~ fence\n~~~ inside";
  assert.equal(unfence(externalFence("handoff", "sample/handoff/x.md", text)), text);
  assert.equal(unfence("plain title"), "plain title");
});
