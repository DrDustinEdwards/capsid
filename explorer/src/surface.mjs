// Capsid's served tools, read at build from the same registrations the Worker makes
// (src/tools/surface.ts), so the tools page can only show what Capsid serves. Every operation is
// defined against a context that holds nothing: a definition stores a description, an input
// schema and a handler, and no handler is ever called here. The source is public, so nothing on
// the tools page is more than the repo already says.
import { defineAdminOperations } from "../../src/tools/admin.ts";
import { defineAgentOperations } from "../../src/tools/agents.ts";
import { defineClaimsOperations } from "../../src/tools/claims.ts";
import { defineCloudflareOperations } from "../../src/tools/cloudflare.ts";
import { defineControlOperations } from "../../src/tools/controls.ts";
import { defineDocOperations } from "../../src/tools/docs.ts";
import { defineJobOperations } from "../../src/tools/jobs.ts";
import { defineLintOperations } from "../../src/tools/lint.ts";
import { Operations } from "../../src/tools/operations.ts";
import { defineOpsSnapshotOperations } from "../../src/tools/ops.ts";
import { defineRepoOperations } from "../../src/tools/repo.ts";
import { defineStatusOperations } from "../../src/tools/status.ts";
import { CAPSID_ADMIN_TOOLS, CAPSID_TOOLS, COMPOSITES, registerCapsidAdminTools, registerCapsidTools } from "../../src/tools/surface.ts";
import { TOOL_GRANTS } from "../../src/scope.ts";

/**
 * @typedef {{ name: string, type: string, required: boolean, description: string, values: string[] }} Param
 * @typedef {{ name: string, summary: string, params: string[] }} Action
 * @typedef {{ name: string, server: "Capsid" | "Capsid Admin", title: string, description: string, grant: string, hints: { readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }, actions: Action[], params: Param[] }} Tool
 */

/** A parameter's type in words, from its JSON Schema. @param {any} s @returns {string} */
function typeOf(s) {
  if (!s || typeof s !== "object") return "any";
  if (s.enum) return "one of";
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf).map(typeOf))].join(" or ");
  if (s.type === "array") return `list of ${typeOf(s.items)}`;
  if (s.type === "integer") return "whole number";
  if (Array.isArray(s.type)) return s.type.join(" or ");
  return s.type ?? "any";
}

/** The fixed values a parameter takes, if it names them. @param {any} s @returns {string[]} */
function valuesOf(s) {
  if (!s || typeof s !== "object") return [];
  if (s.enum) return s.enum.map(String);
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf).flatMap(valuesOf))];
  if (s.type === "array") return valuesOf(s.items);
  return [];
}

/** @param {string} key @param {any} type @returns {Param} */
function param(key, type) {
  // The schema's own method, so the zod that made it writes it (the explorer installs its own).
  const json = type.toJSONSchema({ unrepresentable: "any", io: "input" });
  return { name: key, type: typeOf(json), required: !type.safeParse(undefined).success, description: json.description ?? "", values: valuesOf(json) };
}

/** Every tool Capsid and Capsid Admin serve, in the order tools/list publishes them. @returns {Tool[]} */
export function servedTools() {
  const ops = new Operations();
  /** @type {Array<{ name: string, config: any }>} */
  const registered = [];
  const server = /** @type {any} */ (new Proxy({}, { get: (_t, key) => (key === "registerTool" ? (/** @type {string} */ name, /** @type {any} */ config) => registered.push({ name, config }) : () => undefined) }));
  const ctx = /** @type {any} */ ({ env: {}, db: {}, actor: "", agent: {}, scope: () => null, lastActor: async () => null, ops });
  for (const define of [defineDocOperations, defineLintOperations, defineRepoOperations, defineStatusOperations, defineJobOperations, defineAgentOperations, defineClaimsOperations, defineOpsSnapshotOperations, defineCloudflareOperations, defineControlOperations, defineAdminOperations]) define(server, ctx);
  registerCapsidTools(server, ops);
  registerCapsidAdminTools(server, ops);
  const composites = new Map(COMPOSITES.map((c) => [c.name, c]));
  const admin = new Set(/** @type {readonly string[]} */ (CAPSID_ADMIN_TOOLS));
  const order = [...CAPSID_TOOLS, ...CAPSID_ADMIN_TOOLS];
  return registered
    .sort((a, b) => order.indexOf(/** @type {any} */ (a.name)) - order.indexOf(/** @type {any} */ (b.name)))
    .map(({ name, config }) => {
      const spec = composites.get(name);
      // A tool's schema is an object schema or its shape, as the SDK takes either.
      const shape = config.inputSchema.shape ?? config.inputSchema;
      const params = Object.entries(shape).map(([key, type]) => param(key, type));
      const actions = spec
        ? Object.entries(spec.actions).map(([action, a]) => ({
            name: action,
            summary: a.summary,
            params: a.fields ? [...a.fields] : Object.keys(ops.config(a.op).inputSchema.shape ?? ops.config(a.op).inputSchema).filter((k) => !(a.inject && Object.hasOwn(a.inject, k))),
          }))
        : [];
      return { name, server: admin.has(name) ? "Capsid Admin" : "Capsid", title: config.title, description: config.description, grant: TOOL_GRANTS[name] ?? "write", hints: config.annotations, actions, params };
    });
}
