import assert from "node:assert/strict";
import { test } from "node:test";
import * as plot from "enarratio/plot";
import { backupAges, findingsRange, whoActed, writesCalendar } from "../src/figures.ts";
import { actorLabel, agentRows, heatRows } from "../src/portal-figures.ts";
import { threadsPerDay, topNames } from "../src/portal-board.ts";
import { unfence, externalFence } from "../src/provenance.ts";
import { lastDays } from "../src/trends-days.ts";
import type { PortalBackups } from "../src/ops-types/views.ts";

// The Portal's server-drawn charts on data shaped like production's (fake names): each is drawn,
// states its finding, carries its data table and no style attribute (the Portal's CSP).

const NOW = new Date("2026-11-28T12:00:00.000Z");

function assertFigure(html: string | null, alt: RegExp): string {
  assert.ok(html, "no chart was drawn");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "a style attribute would break the Portal's CSP");
  assert.match(html, /<figure\b/);
  assert.match(html, /<table\b/, "no data table");
  assert.match(html, alt, "the text alternative does not state the finding");
  return html;
}

test("the year's writes are drawn as a calendar that names its busiest day", () => {
  const days = lastDays(NOW, 365);
  const counts = new Map(days.map((d, i) => [d, i % 7 === 0 ? 0 : (i * 13) % 90]));
  const html = assertFigure(writesCalendar(plot, days, counts), /Document writes per day/);
  assert.match(html, /the most \d+ on 20\d\d-\d\d-\d\d/);
  assert.equal(writesCalendar(plot, days, new Map()), null, "an empty year is no chart");
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

test("open problems are drawn from first to last seen, the oldest first", () => {
  const html = assertFigure(
    findingsRange(
      plot,
      [
        {
          namespace: "sample",
          title: "The site answered 503",
          first_seen_at: "2026-11-27 12:00:00",
          last_seen_at: "2026-11-28 11:00:00",
        },
        {
          namespace: "sample",
          title: "The site answered 503",
          first_seen_at: "2026-11-20T12:00:00.000Z",
          last_seen_at: "2026-11-28T11:30:00.000Z",
        },
      ],
      NOW,
    ),
    /2 open problems.*the oldest, sample: The site answered 503 \(2\), first seen 8\.0 days ago/,
  );
  assert.ok(html.length > 0);
  assert.equal(findingsRange(plot, [], NOW), null);
});

test("backup ages are drawn against the 26-hour target, and a site with none is named", () => {
  const b: PortalBackups = {
    read_at: NOW.toISOString(),
    capsid: {
      status: { last_ok: "2026-11-28T03:00:00.000Z", age_hours: 9 },
      amazon: { newest: "2026-11-28T05:00:00.000Z", bytes: 1 },
    },
    sites: [
      {
        namespace: "sample",
        origin: "https://sample.example.com",
        status: { last_ok: null, age_hours: 31 },
        error: null,
        amazon: null,
      },
      {
        namespace: "sample-two",
        origin: "https://two.example.com",
        status: null,
        error: "unreachable",
        amazon: null,
      },
    ],
    amazon_report_at: null,
    not_configured: [],
  };
  const dump = backupAges(plot, b, "dump", NOW);
  assertFigure(dump.chart, /against the 26-hour target: sample 31 h past it/);
  assert.deepEqual(dump.missing, ["sample-two"]);
  const amazon = backupAges(plot, b, "amazon", NOW);
  assertFigure(amazon.chart, /newest Amazon copy.*all 1 site on time/);
  assert.deepEqual(amazon.missing, ["sample", "sample-two"]);
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
