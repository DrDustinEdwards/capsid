import type { McpServer } from "@modelcontextprotocol/server";
import { bounded, nsName } from "../limits";
import { PUBLIC_VERSIONS_KEY } from "../public-data";
import { readResources } from "../system-facts-store";
import type { PublicVersions } from "../system-versions";
import { fail, ok, type ToolCtx } from "./docs";

// The versions and secrets models (src/system-facts.ts), read the way threads read the map:
// what the nightly build stored, never GitHub or Cloudflare, so a call computes nothing.
//   system_versions: capsid_read_status action versions. The public document
//     (/public/versions/v1.json), so the read grant suffices and no namespace is needed.
//   system_resources: capsid_admin_read_ops action resources. Private: secret names,
//     tables and stores across every Worker, so admin only, like the rest of that tool.

export function defineSystemOperations(_server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  ctx.ops.define(
    "system_versions",
    {
      description:
        "The network package versions (Capsomer, Prelum, devkit, Enarratio...) each system installs, read nightly from its lockfiles, with the newest release and how far behind. system or package narrows it. REFUSES: no build yet, an unknown system or package.",
      inputSchema: {
        system: nsName.optional().describe("A system id from system/model.json, such as foxing."),
        package: bounded(100)
          .optional()
          .describe("A package name as the document lists it, such as Capsomer or enarratio."),
      },
    },
    async ({ system, package: pkg }) => {
      const raw = await env.APP_KV.get(PUBLIC_VERSIONS_KEY);
      if (!raw)
        return fail(
          "system_versions: the nightly build has not stored the versions model yet (task system-facts in the run ledger).",
        );
      const doc = JSON.parse(raw) as PublicVersions;
      let systems = doc.systems;
      if (system !== undefined) {
        systems = systems.filter((s) => s.system === system);
        if (!systems.length)
          return fail(
            `system_versions: no system '${system}' pins a network package. Systems: ${doc.systems.map((s) => s.system).join(", ")}.`,
          );
      }
      if (pkg !== undefined) {
        const known = doc.packages.find((p) => p.name.toLowerCase() === pkg.toLowerCase());
        if (!known)
          return fail(
            `system_versions: no package '${pkg}'. Packages: ${doc.packages.map((p) => p.name).join(", ")}.`,
          );
        systems = systems
          .map((s) => ({ ...s, pins: s.pins.filter((p) => p.package === known.name) }))
          .filter((s) => s.pins.length);
        return ok({ as_of: doc.as_of, packages: [known], systems, unread: doc.unread });
      }
      return ok({ as_of: doc.as_of, packages: doc.packages, systems, unread: doc.unread });
    },
  );

  ctx.ops.define(
    "system_resources",
    {
      description:
        "The secrets and data model, as the nightly build read it from Cloudflare: each Worker with its system, its secret and variable names (never a value), and its D1, KV, R2, Durable Object, queue and service bindings; each D1 database with its tables; each KV namespace and R2 bucket; and which Workers and systems use each. script narrows to one Worker. Admin only. Read-only. REFUSES: no build stored yet, a Worker the document does not hold.",
      inputSchema: {
        script: bounded(63).optional().describe("A Worker script name, such as foxing."),
      },
    },
    async ({ script }) => {
      const doc = await readResources(env);
      if (!doc)
        return fail(
          "system_resources: the nightly build has not stored the secrets and data model yet (task system-facts in the run ledger).",
        );
      if (script === undefined) return ok(doc);
      const worker = doc.workers.find((w) => w.script === script);
      if (!worker)
        return fail(
          `system_resources: no Worker '${script}'. Workers: ${doc.workers.map((w) => w.script).join(", ")}.`,
        );
      const uses = (list: Array<{ used_by: Array<{ script: string }> }>) =>
        list.filter((x) => x.used_by.some((u) => u.script === script));
      return ok({
        read_at: doc.read_at,
        worker,
        databases: uses(doc.databases),
        kv_namespaces: uses(doc.kv_namespaces),
        buckets: uses(doc.buckets),
        problems: doc.problems,
      });
    },
  );
}
