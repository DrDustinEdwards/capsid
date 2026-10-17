import { z } from "zod";
import { bounded } from "./limits";

// The system model (capsid/rulings/system-explorer-2026-10-10.md, answers 1 and 2;
// design capsid/research/design-system-explorer.md, sections 1 and 2). One
// machine-readable model of Dustin's systems, hand-written in system/model.json and
// changed by pull request. Every map and diagram is drawn from what toPublic makes of
// it, never from the file itself.
//
// The file holds public-safe facts only. A private system is written as its public
// name, short name, domain, family and ring, plus the repos the drift check reads;
// toPublic is the second line, so a fact typed into the wrong field still never
// reaches the published document.

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

const Id = bounded(64).regex(ID, "an id is lowercase kebab-case");
const Text = bounded(280).trim().min(1);

// Family follows the shared-homes naming (capsid/rulings/shared-homes-2026-10-06.md);
// ring is where the map draws a system: core in the middle, shared parts around it,
// what people use on the outside.
const FAMILIES = ["system", "writing", "product", "plumbing", "site"] as const;
const RINGS = ["core", "shared", "used"] as const;
const CONTAINER_KINDS = ["worker", "database", "bucket", "kv", "queue", "cron", "package", "site", "external"] as const;
const RELATIONSHIP_KINDS = ["installs", "publishes-to", "coordinates", "watches", "reads", "writes", "deploys", "serves"] as const;

const System = z
  .strictObject({
    id: Id,
    name: bounded(40).trim().min(1),
    // The phone map draws a capsomer about 90 px across, so its label is short.
    short: bounded(12).trim().min(1),
    family: z.enum(FAMILIES),
    ring: z.enum(RINGS),
    public: z.boolean(),
    description: Text.optional(),
    domain: bounded(253).regex(DOMAIN).optional(),
    repos: z.array(bounded(200).regex(REPO)).min(1),
    // Answer 15: a public system shown without a link to its repo.
    hide_repo_link: z.boolean().optional(),
    aliases: z.array(Id).optional(),
  })
  .refine((s) => s.public || s.domain !== undefined, {
    message: "a private system appears only as its public name and domain, so it needs a domain (answer 7: one with no public product is left out)",
  })
  .refine((s) => s.public || s.description === undefined, {
    message: "a private system carries no description; its internals never appear",
  });

const Container = z.strictObject({
  id: Id,
  system: Id,
  name: bounded(40).trim().min(1),
  kind: z.enum(CONTAINER_KINDS),
  technology: bounded(60).trim().min(1),
  description: Text.optional(),
});

const Relationship = z.strictObject({
  from: Id,
  to: Id,
  kind: z.enum(RELATIONSHIP_KINDS),
  title: Text.optional(),
});

// A flow (design section 4, animated flows): ordered steps, each riding one relationship
// already in the model, toward one of its two ends, with the sentence the explorer shows
// and the containers it lights. A flow never draws a line of its own, so it cannot show
// a connection the model does not have.
const FlowStep = z.strictObject({
  from: Id,
  kind: z.enum(RELATIONSHIP_KINDS),
  to: Id,
  toward: Id,
  text: Text,
  lights: z.array(Id).max(8).optional(),
});

const Flow = z.strictObject({
  id: Id,
  name: bounded(60).trim().min(1),
  description: Text.optional(),
  steps: z.array(FlowStep).min(2).max(20),
});

export const SystemModelSchema = z
  .strictObject({
    $schema: bounded(512).optional(),
    version: z.literal(1),
    systems: z.array(System).min(1),
    containers: z.array(Container),
    relationships: z.array(Relationship),
    flows: z.array(Flow).optional(),
  })
  .superRefine((m, ctx) => {
    const ids = new Map<string, string>();
    const claim = (id: string, what: string) => {
      const prior = ids.get(id);
      if (prior) ctx.addIssue({ code: "custom", message: `id ${id} is used by a ${prior} and a ${what}` });
      ids.set(id, what);
    };
    for (const s of m.systems) {
      claim(s.id, "system");
      for (const a of s.aliases ?? []) claim(a, `alias of ${s.id}`);
    }
    for (const c of m.containers) claim(c.id, "container");
    const systems = new Set(m.systems.map((s) => s.id));
    const endpoints = new Set([...systems, ...m.containers.map((c) => c.id)]);
    for (const c of m.containers) {
      if (!systems.has(c.system)) ctx.addIssue({ code: "custom", message: `container ${c.id} names system ${c.system}, which does not exist` });
    }
    const seen = new Set<string>();
    for (const r of m.relationships) {
      for (const end of [r.from, r.to]) {
        if (!endpoints.has(end)) ctx.addIssue({ code: "custom", message: `relationship ${r.from} ${r.kind} ${r.to} names ${end}, which does not exist` });
      }
      const key = `${r.from} ${r.kind} ${r.to}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `relationship ${key} is listed twice` });
      seen.add(key);
    }
    const containerSystem = new Map(m.containers.map((c) => [c.id, c.system]));
    const ownerOf = (id: string) => containerSystem.get(id) ?? id;
    for (const f of m.flows ?? []) {
      claim(f.id, "flow");
      f.steps.forEach((step, i) => {
        const where = `flow ${f.id} step ${i + 1}`;
        const key = `${step.from} ${step.kind} ${step.to}`;
        if (!seen.has(key)) ctx.addIssue({ code: "custom", message: `${where} rides ${key}, which is not a relationship in the model` });
        if (step.toward !== step.from && step.toward !== step.to) ctx.addIssue({ code: "custom", message: `${where} goes toward ${step.toward}, which is not an end of ${key}` });
        // A light is a part the step's work touches (a store written while the Worker
        // serves an agent), so it belongs to a system one of the step's ends belongs to.
        const within = new Set([ownerOf(step.from), ownerOf(step.to)]);
        for (const l of step.lights ?? []) {
          const system = containerSystem.get(l);
          if (system === undefined) ctx.addIssue({ code: "custom", message: `${where} lights ${l}, which is not a container` });
          else if (!within.has(system)) ctx.addIssue({ code: "custom", message: `${where} lights ${l}, a part of ${system}, which the step does not run in` });
        }
      });
    }
  });

export type SystemModel = z.infer<typeof SystemModelSchema>;
type ModelSystem = SystemModel["systems"][number];

/** The model, or every problem with it. */
export function parseSystemModel(raw: unknown): { ok: true; model: SystemModel } | { ok: false; problems: string[] } {
  const parsed = SystemModelSchema.safeParse(raw);
  if (parsed.success) return { ok: true, model: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(model)"}: ${i.message}`) };
}

// The published document. Strict schemas, so a key nobody listed fails the test that
// parses toPublic's output, and the site builds validate against the same shape.
const PublicSystemOpen = z.strictObject({
  id: Id,
  name: bounded(40),
  short: bounded(12),
  family: z.enum(FAMILIES),
  ring: z.enum(RINGS),
  private: z.literal(false),
  description: bounded(280).optional(),
  domain: bounded(253).optional(),
  repos: z.array(bounded(512).url()).optional(),
});
// Ruling 3: a private system is a public name and a domain, placed on the map.
export const PRIVATE_SYSTEM_KEYS = ["id", "name", "short", "domain", "family", "ring", "private"] as const;
const PublicSystemPrivate = z.strictObject({
  id: Id,
  name: bounded(40),
  short: bounded(12),
  domain: bounded(253),
  family: z.enum(FAMILIES),
  ring: z.enum(RINGS),
  private: z.literal(true),
});

export const PublicModelSchema = z.strictObject({
  version: z.literal(1),
  as_of: bounded(10).regex(/^\d{4}-\d{2}-\d{2}$/),
  systems: z.array(z.union([PublicSystemOpen, PublicSystemPrivate])),
  containers: z.array(
    z.strictObject({
      id: Id,
      system: Id,
      name: bounded(40),
      kind: z.enum(CONTAINER_KINDS),
      technology: bounded(60),
      description: bounded(280).optional(),
    })
  ),
  relationships: z.array(
    z.strictObject({
      id: bounded(200),
      from: Id,
      to: Id,
      kind: z.enum(RELATIONSHIP_KINDS),
      title: bounded(280).optional(),
    })
  ),
  // Optional so a document built before flows existed still parses; toPublic always writes it.
  flows: z
    .array(
      z.strictObject({
        id: Id,
        name: bounded(60),
        description: bounded(280).optional(),
        steps: z
          .array(
            z.strictObject({
              relationship: bounded(200),
              toward: Id,
              text: bounded(280),
              lights: z.array(Id).max(8).optional(),
            })
          )
          .min(2)
          .max(20),
      })
    )
    .optional(),
  counts: z.strictObject({
    systems: z.number().int(),
    public: z.number().int(),
    private: z.number().int(),
    containers: z.number().int(),
    relationships: z.number().int(),
  }),
});

export type PublicModel = z.infer<typeof PublicModelSchema>;

/** Repo visibility as GitHub reports it, keyed by "owner/name" in lower case: true for
 *  a private repo, false for a public one. A repo missing from the map is unknown. */
export type RepoPrivacy = ReadonlyMap<string, boolean>;

/** A relationship's published id, derived from its ends and kind, never copied from text. */
const relationshipId = (r: { from: string; kind: string; to: string }) => `${r.from}--${r.kind}--${r.to}`;

/** Public only when the model says so AND GitHub says every repo it lists is public.
 *  Any other answer, an unknown repo included, is private. */
function isPublicSystem(s: ModelSystem, privacy: RepoPrivacy): boolean {
  return s.public && s.repos.length > 0 && s.repos.every((r) => privacy.get(r.toLowerCase()) === false);
}

/** Every repo of a public system, with its system: the only repos whose code maps may be
 *  published (design section 2, rule 2). */
export function publicRepos(model: SystemModel, privacy: RepoPrivacy): Array<{ system: string; repo: string }> {
  return model.systems.filter((s) => isPublicSystem(s, privacy)).flatMap((s) => s.repos.map((repo) => ({ system: s.id, repo })));
}

/**
 * The public document: what the explorer and the dustinedwards.info map read.
 *
 * Built by picking named fields into new objects, never by copying an input object and
 * deleting from it, so a field nobody listed here cannot pass through. Rules (design
 * section 2): a system is private unless the model and GitHub both say public; a
 * private system is its PRIVATE_SYSTEM_KEYS and nothing else; its containers are
 * dropped; a relationship with a private end survives only between two systems, with
 * no title (answer 6); an output id is derived from its ends, never copied from text;
 * a flow survives only when every step rides a relationship between public ends and
 * lights only public containers, so a private system's flows are dropped whole.
 * Repos that are not in the model are never read here at all (answer 7).
 */
export function toPublic(model: SystemModel, privacy: RepoPrivacy, asOf: string): PublicModel {
  const open = new Set(model.systems.filter((s) => isPublicSystem(s, privacy)).map((s) => s.id));
  const systemIds = new Set(model.systems.map((s) => s.id));

  const systems: PublicModel["systems"] = model.systems.map((s) => {
    if (!open.has(s.id)) {
      // The schema requires a domain on a model system marked private; a system marked
      // public that GitHub reports private may have none, and then shows its name alone.
      return { id: s.id, name: s.name, short: s.short, domain: s.domain ?? "", family: s.family, ring: s.ring, private: true };
    }
    const out: Extract<PublicModel["systems"][number], { private: false }> = {
      id: s.id,
      name: s.name,
      short: s.short,
      family: s.family,
      ring: s.ring,
      private: false,
    };
    if (s.description !== undefined) out.description = s.description;
    if (s.domain !== undefined) out.domain = s.domain;
    if (!s.hide_repo_link) out.repos = s.repos.map((r) => `https://github.com/${r}`);
    return out;
  });

  const owner = new Map<string, string>();
  for (const s of model.systems) owner.set(s.id, s.id);
  for (const c of model.containers) owner.set(c.id, c.system);

  const containers: PublicModel["containers"] = model.containers
    .filter((c) => open.has(c.system))
    .map((c) => {
      const out: PublicModel["containers"][number] = { id: c.id, system: c.system, name: c.name, kind: c.kind, technology: c.technology };
      if (c.description !== undefined) out.description = c.description;
      return out;
    });

  const relationships: PublicModel["relationships"] = [];
  // Relationships whose two ends are both public: the only ones a flow may ride.
  const publicEdges = new Set<string>();
  for (const r of model.relationships) {
    const fromOwner = owner.get(r.from);
    const toOwner = owner.get(r.to);
    if (fromOwner === undefined || toOwner === undefined) continue;
    const id = relationshipId(r);
    if (open.has(fromOwner) && open.has(toOwner)) {
      publicEdges.add(id);
      const out: PublicModel["relationships"][number] = { id, from: r.from, to: r.to, kind: r.kind };
      if (r.title !== undefined) out.title = r.title;
      relationships.push(out);
    } else if (systemIds.has(r.from) && systemIds.has(r.to)) {
      relationships.push({ id, from: r.from, to: r.to, kind: r.kind });
    }
  }

  const publicContainers = new Set(containers.map((c) => c.id));
  const flows: NonNullable<PublicModel["flows"]> = [];
  for (const f of model.flows ?? []) {
    const steps = f.steps.map((step) => ({ step, relationship: relationshipId(step) }));
    const whole = steps.every(({ step, relationship }) => publicEdges.has(relationship) && (step.lights ?? []).every((l) => publicContainers.has(l)));
    if (!whole) continue;
    const out: NonNullable<PublicModel["flows"]>[number] = {
      id: f.id,
      name: f.name,
      steps: steps.map(({ step, relationship }) => {
        const s: NonNullable<PublicModel["flows"]>[number]["steps"][number] = { relationship, toward: step.toward, text: step.text };
        if (step.lights?.length) s.lights = [...step.lights];
        return s;
      }),
    };
    if (f.description !== undefined) out.description = f.description;
    flows.push(out);
  }

  return {
    version: 1,
    as_of: asOf,
    systems,
    containers,
    relationships,
    flows,
    counts: {
      systems: systems.length,
      public: open.size,
      private: systems.length - open.size,
      containers: containers.length,
      relationships: relationships.length,
    },
  };
}
