import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hintsFor } from "../tool-annotations";
import { z } from "zod";
import { CF_CONFIG_ACTIONS, CF_PERMISSION, readCloudflareConfig } from "../ops-cloudflare-config";
import { fail, ok, type ToolCtx } from "./docs";

// A zone name as Cloudflare lists it: labels of letters, digits and hyphens.
const ZONE_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function registerCloudflareTools(server: McpServer, ctx: ToolCtx): void {
  const { env } = ctx;

  // Cloudflare Access and Email Routing, read. Ruled 2026-09-29, "Capsid MCP roadmap,
  // build or don't build" (capsid/decisions.md). Admin only in whole: it reads the
  // account's login gates and mail routes, which span every namespace. TOOL_GRANTS in
  // src/scope.ts states it and the registrar refuses anyone else before this handler
  // runs. It reads only, through src/ops-cloudflare-config.ts, which copies named
  // fields and never passes a Cloudflare object through, so no client secret, SCIM
  // credential or aud tag reaches the caller.
  server.registerTool(
    "cloudflare_config",
    {
      annotations: hintsFor("cloudflare_config"),
      description:
        `Cloudflare Access and Email Routing configuration for the account, read with CF_OPS_TOKEN. Admin only. It reads and never writes. action "access_apps": each Access application's id, name, domain, type, self_hosted_domains, destinations (type, uri, hostname) and its policies (name, decision). action "access_policies": each reusable policy's id, name, decision and its include, exclude and require rules as types, with the value only for email (the address), email_domain (the domain), group (the group id) and service_token (the token id). action "email_rules": each zone's Email Routing rules (name, enabled, priority, matchers, actions); zone narrows it to one zone name, else every zone in the account. action "email_addresses": each destination address and whether it is verified. Client secrets, SCIM credentials and aud tags are never returned. A 403 names the permission the token lacks: ${CF_PERMISSION.access} for Access, ${CF_PERMISSION.zones} and ${CF_PERMISSION.rules} for rules, ${CF_PERMISSION.addresses} for addresses.`,
      inputSchema: {
        action: z.enum(CF_CONFIG_ACTIONS).describe("access_apps | access_policies | email_rules | email_addresses."),
        zone: z.string().regex(ZONE_NAME).optional().describe("For email_rules: one zone name, such as example.com. Omitted reads every zone in the account."),
      },
    },
    async (args) => {
      try {
        if (args.zone !== undefined && args.action !== "email_rules") return fail(`zone applies to email_rules only, and this call is ${args.action}.`);
        // Looked up per call, not captured, so the Worker's fetch is the one in scope.
        return ok(await readCloudflareConfig(env, args.action, args.zone?.toLowerCase(), (url, init) => fetch(url, init)));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
