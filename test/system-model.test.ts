import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  PublicModelSchema,
  SystemModelSchema,
  parseSystemModel,
  toPublic,
  type RepoPrivacy,
  type SystemModel,
} from "../src/system-model.ts";

// The public document (docs/public-data.md). Every system is published whole, private
// ones included (Dustin, 2026-10-23); a system whose repo GitHub does not report public
// carries no repo link, so its repo's address never reaches the document.

const ROOT = join(import.meta.dirname, "..");
const SECRET_REPO = "example-org/sample-private-7f3a9c";

function fixture(): SystemModel {
  return {
    version: 1,
    systems: [
      { id: "sample-open", name: "Sample Open", short: "Open", family: "writing", ring: "used", description: "A public sample system.", domain: "open.example.com", repos: ["example-org/sample-open"] },
      { id: "sample-private", name: "Sample Private", short: "Private", family: "product", ring: "used", description: "A private sample system.", repos: [SECRET_REPO] },
    ],
    containers: [
      { id: "open-worker", system: "sample-open", name: "Open Worker", kind: "worker", technology: "Cloudflare Worker" },
      { id: "private-db", system: "sample-private", name: "private db", kind: "database", technology: "D1", description: "Holds the rows." },
    ],
    relationships: [
      { from: "open-worker", to: "private-db", kind: "writes", title: "writes the rows" },
      { from: "sample-open", to: "sample-private", kind: "publishes-to" },
    ],
    flows: [
      {
        id: "sample-flow",
        name: "Sample",
        steps: [
          { from: "open-worker", kind: "writes", to: "private-db", toward: "private-db", text: "Writes." },
          { from: "sample-open", kind: "publishes-to", to: "sample-private", toward: "sample-private", lights: ["private-db"], text: "Publishes." },
        ],
      },
    ],
  };
}

const reposOf = (out: { systems: Array<{ id: string }> }, id: string) => {
  const s = out.systems.find((x) => x.id === id);
  return s && "repos" in s ? s.repos : undefined;
};

test("a private system is published whole but for its repo link, whatever GitHub's answer", () => {
  const cases: Array<[string, RepoPrivacy]> = [
    ["GitHub says private", new Map([["example-org/sample-open", false], [SECRET_REPO, true]])],
    ["GitHub's read misses the repo", new Map([["example-org/sample-open", false]])],
  ];
  for (const [name, privacy] of cases) {
    const out = toPublic(fixture(), privacy, "2026-10-23");
    const parsed = PublicModelSchema.safeParse(out);
    assert.ok(parsed.success, parsed.success ? name : parsed.error.message);
    const priv = out.systems.find((s) => s.id === "sample-private");
    assert.deepEqual(priv, { id: "sample-private", name: "Sample Private", short: "Private", family: "product", ring: "used", private: true, description: "A private sample system." }, name);
    assert.deepEqual(reposOf(out, "sample-open"), ["https://github.com/example-org/sample-open"], name);
    assert.ok(!JSON.stringify(out).includes(SECRET_REPO), `${name}: the private repo reached the document`);
    assert.deepEqual(out.counts, { systems: 2, public: 1, private: 1, containers: 2, relationships: 2 }, name);
    assert.deepEqual(out.flows?.map((f) => f.steps.map((st) => st.relationship)), [["open-worker--writes--private-db", "sample-open--publishes-to--sample-private"]], name);
  }
  // GitHub says public: the link is shown.
  const open = toPublic(fixture(), new Map([["example-org/sample-open", false], [SECRET_REPO, false]]), "2026-10-23");
  assert.deepEqual(reposOf(open, "sample-private"), [`https://github.com/${SECRET_REPO}`]);
});

test("the published schema is strict, so a key toPublic did not write fails the site builds", () => {
  const out = toPublic(fixture(), new Map(), "2026-10-23");
  const planted = structuredClone(out) as { systems: Array<Record<string, unknown>> };
  planted.systems[0].internal_notes = "x";
  assert.equal(PublicModelSchema.safeParse(planted).success, false);
  const linked = structuredClone(out) as { systems: Array<Record<string, unknown>> };
  linked.systems[1].repos = [`https://github.com/${SECRET_REPO}`];
  assert.equal(PublicModelSchema.safeParse(linked).success, false, "a private system with a repo link passed");
});

// The committed model: the CI half of the drift check (design section 1).
const MODEL = JSON.parse(readFileSync(join(ROOT, "system", "model.json"), "utf8"));

test("system/model.json passes its schema, and the schema refuses what it should", () => {
  const parsed = parseSystemModel(MODEL);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("\n"));
  const model = parsed.model;
  assert.ok(model.systems.length >= 10, `the model lists only ${model.systems.length} systems`);
  assert.ok(model.relationships.length > 0 && model.containers.length > 0);

  const broken = structuredClone(MODEL);
  broken.relationships.push({ from: "capsid", to: "nowhere", kind: "reads" });
  broken.systems.push({ ...broken.systems[0] });
  const refused = parseSystemModel(broken);
  assert.equal(refused.ok, false);
  const problems = refused.ok ? [] : refused.problems.join("\n");
  assert.match(String(problems), /names nowhere, which does not exist/);
  assert.match(String(problems), /id capsid is used by a system and a system/);
});

test("system/model.schema.json is the schema the code enforces", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "system", "model.schema.json"), "utf8"));
  const generated = z.toJSONSchema(SystemModelSchema, { io: "input" });
  assert.deepEqual(committed, generated, "system/model.schema.json is stale: run `node --import ./test/resolve-ts.mjs scripts/write-system-schema.mjs`");
});

// Flows (design section 4): ordered steps over relationships the model already has.
test("a flow step must ride a relationship in the model, toward one of its ends, lighting only containers", () => {
  const broken = structuredClone(MODEL);
  broken.containers.push({ id: "sample-elsewhere", system: "carrel", name: "Elsewhere", kind: "worker", technology: "Cloudflare Worker" });
  broken.flows = [
    {
      id: "sample-flow",
      name: "Sample",
      steps: [
        { from: "capsid-worker", kind: "serves", to: "capsid-agents", toward: "capsid-worker", text: "Fine." },
        { from: "capsid-agents", kind: "writes", to: "capsid-db", toward: "capsid-db", text: "No such edge." },
        { from: "capsid-worker", kind: "writes", to: "capsid-db", toward: "capsid-media", text: "Wrong end." },
        { from: "capsid-worker", kind: "writes", to: "capsid-db", toward: "capsid-db", lights: ["capsid"], text: "A system is not a container." },
        { from: "capsid-worker", kind: "writes", to: "capsid-db", toward: "capsid-db", lights: ["sample-elsewhere"], text: "Another system's part." },
      ],
    },
    { id: "capsid", name: "Clash", steps: [] },
  ];
  const refused = parseSystemModel(broken);
  assert.equal(refused.ok, false);
  const problems = refused.ok ? "" : refused.problems.join("\n");
  assert.match(problems, /flow sample-flow step 2 rides capsid-agents writes capsid-db, which is not a relationship in the model/);
  assert.match(problems, /flow sample-flow step 3 goes toward capsid-media, which is not an end of capsid-worker writes capsid-db/);
  assert.match(problems, /flow sample-flow step 4 lights capsid, which is not a container/);
  assert.match(problems, /flow sample-flow step 5 lights sample-elsewhere, a part of carrel, which the step does not run in/);
  assert.match(problems, /id capsid is used by a system and a flow/);
  assert.match(problems, /flows\.1\.steps/);
});
