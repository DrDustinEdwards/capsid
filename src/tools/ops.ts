import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { OPS_SNAPSHOT_KEY, readSnapshot, RING_SLOTS, ringReading } from "../ops-snapshot";
import { bounded, nsName } from "../limits";
import { fail, ok, type ToolCtx } from "./docs";

// An ISO time, as the other tools bound a timestamp argument.
const MAX_AT = 40;

export function registerOpsTools(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  // The watcher's last pass, the value the Portal's Watch Floor reads (ops:snapshot in
  // APP_KV, src/ops-snapshot.ts). Ruled 2026-09-29, "Capsid MCP roadmap, build or don't
  // build" (capsid/decisions.md). Admin only in whole: the snapshot spans every
  // namespace's sites, CI and Cloudflare state. TOOL_GRANTS.ops_snapshot in src/scope.ts
  // states it and the registrar refuses anyone else before this handler runs. It reads
  // one KV value and writes nothing.
  server.registerTool(
    "ops_snapshot",
    {
      annotations: hintsFor("ops_snapshot"),
      description: `The watcher's last pass as the Watch Floor reads it (${OPS_SNAPSHOT_KEY}): every check's state and findings, /health, the backup mirror, each roster repo's latest CI run, the site map, and every site's probe, Cloudflare state and 7-day uptime ring. Admin only. It reads and never writes. With no arguments it returns the whole snapshot. site (a namespace) returns that site's entry with the pass time. site with slot (0 to ${RING_SLOTS - 1}, 0 the newest half hour) or at (an ISO time) returns that site's ring value for one half-hour slot, with the window it covers: up, down, no-pass (no pass reached it) or outside-ring (older than the history held). REFUSES: no snapshot written yet or one that does not parse, a site the snapshot does not hold, slot or at without site, slot with at, and a slot or time outside the ring.`,
      inputSchema: {
        site: nsName.optional().describe("A site's namespace, as the snapshot's sites list names it."),
        slot: z
          .number()
          .int()
          .min(0)
          .max(RING_SLOTS - 1)
          .optional()
          .describe(`With site: a ring slot counted back from the newest (0), up to ${RING_SLOTS - 1}.`),
        at: bounded(MAX_AT).optional().describe("With site: the ISO time whose half-hour slot to read."),
      },
    },
    async ({ site, slot, at }) => {
      try {
        if ((slot !== undefined || at !== undefined) && site === undefined) {
          return fail("ops_snapshot: slot and at read one site's ring, so they need site.");
        }
        if (slot !== undefined && at !== undefined) {
          return fail("ops_snapshot: pass slot or at, not both.");
        }
        const snapshot = await readSnapshot(env);
        if (!snapshot) {
          // readSnapshot treats a value that does not parse, or a version other than 1,
          // as absent, and logs which. Both mean there is nothing current to read.
          return fail(
            `ops_snapshot: there is no readable snapshot at ${OPS_SNAPSHOT_KEY}. The watcher has not written one yet, or the stored value did not parse as version 1. The watcher's next pass writes it; the Portal's Refresh runs one now.`
          );
        }
        if (site === undefined) return ok(snapshot);

        const entry = snapshot.sites.find((s) => s.namespace === site);
        if (!entry) {
          const held = snapshot.sites.map((s) => s.namespace);
          return fail(`ops_snapshot: the snapshot of ${snapshot.pass_at} holds no site '${site}'. It holds: ${held.join(", ") || "no sites"}.`);
        }
        if (slot === undefined && at === undefined) return ok({ pass_at: snapshot.pass_at, site: entry });

        const reading = ringReading(entry, slot !== undefined ? { slot } : { at: new Date(at as string) });
        if (typeof reading === "string") return fail(`ops_snapshot: ${reading}`);
        return ok({ pass_at: snapshot.pass_at, ...reading });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
