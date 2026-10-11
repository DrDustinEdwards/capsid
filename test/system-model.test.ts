import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  PRIVATE_SYSTEM_KEYS,
  PublicModelSchema,
  SystemModelSchema,
  parseSystemModel,
  toPublic,
  type RepoPrivacy,
  type SystemModel,
} from "../src/system-model.ts";

// The privacy filter (capsid/rulings/system-explorer-2026-10-10.md, ruling 3 and
// answers 6 and 7; docs/public-data.md). A private repo in the input never reaches the
// output: not its containers, not its descriptions, not its repo name, not an id or a
// title written on a relationship that touches it.

const ROOT = join(import.meta.dirname, "..");
const CANARY = "CANARY-7f3a9c";

// A fixture with one public system and one private system that carries a canary in
// every free-text field the model allows it, and in every field it should not have.
function fixture(): SystemModel {
  return {
    version: 1,
    systems: [
      {
        id: "sample-open",
        name: "Sample Open",
        short: "Open",
        family: "writing",
        ring: "used",
        public: true,
        description: "A public sample system.",
        domain: "open.example.com",
        repos: ["example-org/sample-open"],
      },
      {
        id: "sample-private",
        name: "Sample Private",
        short: "Private",
        family: "product",
        ring: "used",
        public: false,
        domain: "private.example.com",
        repos: [`example-org/${CANARY.toLowerCase()}-repo`],
      },
      {
        // Marked public in the model, but GitHub will say otherwise in some tests.
        id: "sample-claimed",
        name: "Sample Claimed",
        short: "Claimed",
        family: "site",
        ring: "used",
        public: true,
        description: `claimed system description ${CANARY}`,
        domain: "claimed.example.com",
        repos: [`example-org/claimed-${CANARY.toLowerCase()}`],
      },
    ],
    containers: [
      { id: "open-worker", system: "sample-open", name: "Open Worker", kind: "worker", technology: "Cloudflare Worker" },
      {
        id: `${CANARY.toLowerCase()}-db`,
        system: "sample-private",
        name: `private db ${CANARY}`,
        kind: "database",
        technology: `D1 ${CANARY}`,
        description: `holds the ${CANARY} rows`,
      },
      {
        id: `claimed-${CANARY.toLowerCase()}-kv`,
        system: "sample-claimed",
        name: `claimed kv ${CANARY}`,
        kind: "kv",
        technology: "Workers KV",
      },
    ],
    relationships: [
      { from: "open-worker", to: "sample-open", kind: "serves", title: "open title" },
      { from: "sample-open", to: "sample-private", kind: "publishes-to", title: `publishes the ${CANARY} catalog` },
      { from: "open-worker", to: `${CANARY.toLowerCase()}-db`, kind: "writes", title: `writes ${CANARY}` },
      { from: `${CANARY.toLowerCase()}-db`, to: "sample-open", kind: "reads" },
      { from: "sample-open", to: "sample-claimed", kind: "installs", title: `claimed ${CANARY}` },
    ],
  };
}

const ALL_PUBLIC: RepoPrivacy = new Map([
  ["example-org/sample-open", false],
  [`example-org/${CANARY.toLowerCase()}-repo`, true],
  [`example-org/claimed-${CANARY.toLowerCase()}`, false],
]);

function assertNoCanary(out: unknown) {
  const text = JSON.stringify(out);
  assert.ok(!text.toLowerCase().includes(CANARY.toLowerCase()), `the public document leaks the canary: ${text}`);
}

test("a private system reaches the output as its allowed keys alone: no containers, text, repo or titled edge", () => {
  const model = fixture();
  const out = toPublic(model, ALL_PUBLIC, "2026-10-10");
  assert.ok(PublicModelSchema.safeParse(out).success, "the output does not match the published schema");

  const priv = out.systems.find((s) => s.id === "sample-private");
  assert.ok(priv, "the private system is missing from the map; it should appear as a name and domain");
  assert.deepEqual(Object.keys(priv).sort(), [...PRIVATE_SYSTEM_KEYS].sort());
  assert.equal(priv.private, true);
  assert.equal(priv.domain, "private.example.com");

  assert.deepEqual(
    out.containers.filter((c) => c.system !== "sample-open" && c.system !== "sample-claimed").map((c) => c.id),
    [],
    "a private system's container reached the output"
  );
  // The private system's edges: the system-level one survives without its title; the
  // two that touch its container are dropped.
  const touching = out.relationships.filter((r) => r.from.includes("private") || r.to.includes("private") || r.from.includes("db") || r.to.includes("db"));
  assert.deepEqual(touching, [{ id: "sample-open--publishes-to--sample-private", from: "sample-open", to: "sample-private", kind: "publishes-to" }]);
  // The claimed system is public here, so its own text is kept; the canary check runs
  // on the case where it is private, below.
  const withoutClaimed = { ...out, systems: out.systems.filter((s) => s.id !== "sample-claimed"), containers: out.containers.filter((c) => c.system !== "sample-claimed"), relationships: out.relationships.filter((r) => r.to !== "sample-claimed") };
  assertNoCanary(withoutClaimed);
});

test("visibility both ways: a system is public only when the model and GitHub both say so", () => {
  const cases: Array<{ name: string; privacy: RepoPrivacy }> = [
    { name: "model public, GitHub private", privacy: new Map([...ALL_PUBLIC, [`example-org/claimed-${CANARY.toLowerCase()}`, true]]) },
    { name: "model public, GitHub read missing the repo", privacy: new Map([["example-org/sample-open", false]]) },
    { name: "GitHub read empty", privacy: new Map() },
  ];
  for (const c of cases) {
    const out = toPublic(fixture(), c.privacy, "2026-10-10");
    const claimed = out.systems.find((s) => s.id === "sample-claimed");
    assert.ok(claimed, c.name);
    assert.deepEqual(Object.keys(claimed).sort(), [...PRIVATE_SYSTEM_KEYS].sort(), c.name);
    assertNoCanary(out);
  }
  // Model private, GitHub public: still private.
  const out = toPublic(fixture(), new Map([...ALL_PUBLIC, [`example-org/${CANARY.toLowerCase()}-repo`, false]]), "2026-10-10");
  assert.equal(out.systems.find((s) => s.id === "sample-private")?.private, true);
  assert.equal(out.counts.private, 1);
  assert.equal(out.counts.public, 2);
});

test("a repo GitHub lists that the model does not name never appears, not even by name", () => {
  const privacy = new Map([...ALL_PUBLIC, ["example-org/unlisted-side-project", false], ["example-org/unlisted-private", true]]);
  const text = JSON.stringify(toPublic(fixture(), privacy, "2026-10-10"));
  assert.ok(!text.includes("unlisted"), text);
});

test("the output carries only listed keys, walked over every node", () => {
  const out = toPublic(fixture(), ALL_PUBLIC, "2026-10-10");
  // Strict parse: an extra key anywhere fails.
  const parsed = PublicModelSchema.safeParse(out);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  const planted = structuredClone(out) as { systems: Array<Record<string, unknown>> };
  planted.systems[0].internal_notes = "x";
  assert.equal(PublicModelSchema.safeParse(planted).success, false, "the strict schema let an extra key through, so it checks nothing");
  // Paired with what was read, so a pass cannot mean an empty document.
  assert.deepEqual(out.counts, { systems: 3, public: 2, private: 1, containers: 2, relationships: 3 });
  assert.equal(out.systems.length, 3);
});

test("seeded random models: no private system ever carries more than its allowed keys or any canary", () => {
  let seed = 20261010;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  let privateSeen = 0;
  let flowsKept = 0;
  let flowsDropped = 0;
  for (let run = 0; run < 500; run++) {
    const n = 2 + Math.floor(rand() * 6);
    const systems: SystemModel["systems"] = [];
    const privacy = new Map<string, boolean>();
    for (let i = 0; i < n; i++) {
      const modelPublic = rand() < 0.5;
      const repo = `example-org/r${run}-${i}`;
      const gh = rand();
      if (gh < 0.8) privacy.set(repo, gh < 0.4);
      systems.push({
        id: `s${i}`,
        name: `S${i}`,
        short: `S${i}`,
        family: pick(["system", "writing", "product", "plumbing", "site"] as const),
        ring: pick(["core", "shared", "used"] as const),
        public: modelPublic,
        ...(modelPublic ? { description: `text ${CANARY}` } : {}),
        domain: `s${i}.example.com`,
        repos: [repo],
      });
    }
    const containers: SystemModel["containers"] = systems.map((s, i) => ({
      id: `c${i}`,
      system: s.id,
      name: `c ${CANARY}`,
      kind: "worker",
      technology: `t ${CANARY}`,
      description: `d ${CANARY}`,
    }));
    const ids = [...systems.map((s) => s.id), ...containers.map((c) => c.id)];
    const relationships: SystemModel["relationships"] = [];
    const seen = new Set<string>();
    for (let k = 0; k < n * 2; k++) {
      const from = pick(ids);
      const to = pick(ids);
      const key = `${from}>${to}`;
      if (from === to || seen.has(key)) continue;
      seen.add(key);
      relationships.push({ from, to, kind: "reads", title: `title ${CANARY}` });
    }
    // Flows over the generated edges, each lighting a part of its first step's start, every
    // text carrying the canary: only a flow whose every edge and light is public may survive.
    const flows: NonNullable<SystemModel["flows"]> = [];
    for (let f = 0; f < 2 && relationships.length > 0; f++) {
      const steps = [pick(relationships), pick(relationships)].map((r) => ({ from: r.from, kind: r.kind, to: r.to, toward: r.to, text: `step ${CANARY}`, lights: [`c${ownerOf(r.from).slice(1)}`] }));
      flows.push({ id: `f${f}`, name: `flow ${CANARY}`, steps });
    }
    const out = toPublic({ version: 1, systems, containers, relationships, flows }, privacy, "2026-10-10");
    const open = new Set(out.systems.filter((s) => !s.private).map((s) => s.id));
    for (const f of out.flows ?? []) {
      flowsKept++;
      for (const step of f.steps) {
        const [from, , to] = step.relationship.split("--");
        assert.ok(open.has(ownerOf(from ?? "")) && open.has(ownerOf(to ?? "")), `flow ${f.id} rides ${step.relationship}, which has a private end`);
        for (const l of step.lights ?? []) assert.ok(open.has(ownerOf(l)), `flow ${f.id} lights ${l}, a private part`);
      }
    }
    flowsDropped += flows.length - (out.flows?.length ?? 0);
    for (const s of out.systems) {
      if (!s.private) continue;
      privateSeen++;
      assert.deepEqual(Object.keys(s).sort(), [...PRIVATE_SYSTEM_KEYS].sort());
    }
    // Strip the public systems' own text (allowed), then no canary may remain.
    const stripped = {
      systems: out.systems.filter((s) => s.private),
      containers: out.containers.filter((c) => !open.has(c.system)),
      relationships: out.relationships.filter((r) => !(open.has(ownerOf(r.from)) && open.has(ownerOf(r.to)))),
    };
    assertNoCanary(stripped);
    assert.ok(PublicModelSchema.safeParse(out).success);
  }
  assert.ok(privateSeen > 500, `only ${privateSeen} private systems were generated, too few to prove anything`);
  assert.ok(flowsKept > 20 && flowsDropped > 50, `flows kept ${flowsKept}, dropped ${flowsDropped}: too few of either to prove anything`);
});

function ownerOf(id: string): string {
  return id.startsWith("c") ? `s${id.slice(1)}` : id;
}

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
  broken.systems.push({ id: "secret", name: "S", short: "S", family: "product", ring: "used", public: false, description: "internals", repos: ["a/b"] });
  const refused = parseSystemModel(broken);
  assert.equal(refused.ok, false);
  const problems = refused.ok ? [] : refused.problems.join("\n");
  assert.match(String(problems), /names nowhere, which does not exist/);
  assert.match(String(problems), /id capsid is used by a system and a system/);
  assert.match(String(problems), /needs a domain/);
  assert.match(String(problems), /carries no description/);
});

test("system/model.json names no repo that has no public product (answer 7)", () => {
  // The repos that exist privately with no product. The model must never name them;
  // the drift step reads their names from Capsid, never from this public file.
  const text = JSON.stringify(MODEL);
  for (const name of ["bsw", "novels", "capsid-backups", "claude-skills-private", "recova", "foxing-admin-mcp"]) {
    assert.ok(!new RegExp(`/${name}"`).test(text), `system/model.json names ${name}`);
  }
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

test("the committed job's-life flow reaches the public document whole, every step on a public relationship", () => {
  const model = parseSystemModel(MODEL);
  assert.ok(model.ok);
  const privacy: RepoPrivacy = new Map(model.model.systems.flatMap((s) => s.repos.map((r) => [r.toLowerCase(), !s.public] as const)));
  const out = toPublic(model.model, privacy, "2026-10-11");
  assert.ok(PublicModelSchema.safeParse(out).success);
  const life = out.flows?.find((f) => f.id === "job-life");
  assert.ok(life, "job-life did not reach the public document");
  const edges = new Map(out.relationships.map((r) => [r.id, r]));
  assert.equal(life.steps.length, model.model.flows?.find((f) => f.id === "job-life")?.steps.length);
  for (const step of life.steps) {
    const edge = edges.get(step.relationship);
    assert.ok(edge, `a step rides ${step.relationship}, which the document does not carry`);
    assert.ok(step.toward === edge.from || step.toward === edge.to);
  }
});

// A light on a private part needs a step in that private system (the schema's rule), and that
// step's edge is never public, so the edge check drops it; toPublic checks lights as well.
test("a flow that touches a private system is dropped whole, its name and text with it", () => {
  const model = fixture();
  model.flows = [
    {
      id: "open-flow",
      name: "Open",
      steps: [
        { from: "open-worker", kind: "serves", to: "sample-open", toward: "sample-open", text: "Open step." },
        { from: "open-worker", kind: "serves", to: "sample-open", toward: "open-worker", lights: ["open-worker"], text: "Back." },
      ],
    },
    {
      id: "leaky-flow",
      name: `Leaky ${CANARY}`,
      steps: [
        { from: "open-worker", kind: "serves", to: "sample-open", toward: "sample-open", text: `first ${CANARY}` },
        { from: "open-worker", kind: "writes", to: `${CANARY.toLowerCase()}-db`, toward: `${CANARY.toLowerCase()}-db`, text: `into the ${CANARY} db` },
      ],
    },
  ];
  assert.ok(parseSystemModel(model).ok, "the fixture's flows should pass the model's own checks");
  const out = toPublic(model, ALL_PUBLIC, "2026-10-11");
  assert.deepEqual(out.flows?.map((f) => f.id), ["open-flow"]);
  assertNoCanary(out.flows);
  assert.deepEqual(Object.keys(out.flows?.[0]?.steps[1] ?? {}).sort(), ["lights", "relationship", "text", "toward"]);
});
