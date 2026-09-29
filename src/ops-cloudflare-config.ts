import type { Env } from "./env";
import { CF_API, CfReadError, cfGetAll, cloudflareCredentials, type FetchLike } from "./ops-cloudflare";

// The cloudflare_config tool's reads: Access applications and policies, and Email
// Routing rules and destination addresses. Ruled 2026-09-29, "Capsid MCP roadmap,
// build or don't build" (capsid/decisions.md). Only src/tools/cloudflare.ts imports
// this module (test/ops-cloudflare-config.test.ts), and that tool is admin only.
//
// Every reader copies named fields into a fresh object. Nothing Cloudflare returns is
// passed through whole, because these objects carry secrets beside their settings: an
// Access for SaaS app holds saas_app.client_secret, and SCIM provisioning holds
// scim_config.authentication.{password, token, client_secret}. A field Cloudflare adds
// later is therefore dropped until it is named here. Never read: saas_app, scim_config,
// aud, or any other field not listed below.
//
// Permissions, all on CF_OPS_TOKEN (the steps to add them are in src/ops-cloudflare.ts
// and docs/portal.md, "The Cloudflare token"). A 403 names the one that is missing.

export const CF_CONFIG_ACTIONS = ["access_apps", "access_policies", "email_rules", "email_addresses"] as const;
export type CfConfigAction = (typeof CF_CONFIG_ACTIONS)[number];

export const CF_PERMISSION = {
  access: "Account / Access: Apps and Policies / Read",
  zones: "Zone / Zone / Read (Zone Resources: All zones from the account)",
  rules: "Zone / Email Routing Rules / Read",
  addresses: "Account / Email Routing Addresses / Read",
} as const;

// Access lists page up to 1000; zones, rules and addresses up to 50. One size for all.
const PER_PAGE = 50;
const MAX_TEXT = 512;

interface AccessAppOut {
  id: string | null;
  name: string | null;
  domain: string | null;
  type: string | null;
  self_hosted_domains: string[];
  destinations: Array<{ type: string | null; uri: string | null; hostname: string | null }>;
  policies: Array<{ name: string | null; decision: string | null }>;
}

interface AccessRuleOut {
  type: string;
  // Present only for the rule types whose value is not a secret: email (the address),
  // email_domain (the domain), group (the group id; the rule carries no name) and
  // service_token (the token id, never the token).
  value?: string;
}

interface AccessPolicyOut {
  id: string | null;
  name: string | null;
  decision: string | null;
  include: AccessRuleOut[];
  exclude: AccessRuleOut[];
  require: AccessRuleOut[];
}

interface EmailRuleOut {
  name: string | null;
  enabled: boolean | null;
  priority: number | null;
  matchers: Array<{ type: string | null; field: string | null; value: string | null }>;
  actions: Array<{ type: string | null; value: string[] }>;
}

interface EmailAddressOut {
  email: string | null;
  verified: boolean;
}

type CfConfigResult =
  | { action: "access_apps"; count: number; apps: AccessAppOut[] }
  | { action: "access_policies"; count: number; policies: AccessPolicyOut[] }
  | { action: "email_rules"; zones: Array<{ zone: string; count: number; rules: EmailRuleOut[] }> }
  | { action: "email_addresses"; count: number; addresses: EmailAddressOut[] };

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, MAX_TEXT) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texts = (v: unknown): string[] => list(v).map(text).filter((s): s is string => s !== null);

/** One list read, with a 403 turned into the permission the token lacks. Any other
 *  failure keeps Cloudflare's own message. */
async function readAll(fetchImpl: FetchLike, token: string, url: string, what: string, permission: string): Promise<unknown[]> {
  try {
    return await cfGetAll(fetchImpl, token, url, what, PER_PAGE);
  } catch (err) {
    if (err instanceof CfReadError && err.status === 403) {
      throw new Error(
        `${what} was refused with 403: CF_OPS_TOKEN lacks ${permission}. ` +
          `Add it at dash.cloudflare.com/profile/api-tokens, token capsid-portal-read, Edit (docs/portal.md, "The Cloudflare token"). ` +
          `Cloudflare said: ${err.message}`
      );
    }
    throw err;
  }
}

function toAccessApp(raw: unknown): AccessAppOut {
  const a = obj(raw);
  return {
    id: text(a.id),
    name: text(a.name),
    domain: text(a.domain),
    type: text(a.type),
    self_hosted_domains: texts(a.self_hosted_domains),
    destinations: list(a.destinations).map((d) => {
      const o = obj(d);
      return { type: text(o.type), uri: text(o.uri), hostname: text(o.hostname) };
    }),
    policies: list(a.policies).map((p) => {
      const o = obj(p);
      return { name: text(o.name), decision: text(o.decision) };
    }),
  };
}

// The one field each value-bearing rule type may show. Every other type shows its
// type alone: its value is an identity provider id, a list id, an IP range or a
// claim, none of which the tool was ruled to return.
const RULE_VALUE: Record<string, string> = {
  email: "email",
  email_domain: "domain",
  group: "id",
  service_token: "token_id",
};

function toAccessRule(raw: unknown): AccessRuleOut {
  const r = obj(raw);
  const type = Object.keys(r)[0];
  if (type === undefined) return { type: "unknown" };
  const out: AccessRuleOut = { type: type.slice(0, 64) };
  if (Object.hasOwn(RULE_VALUE, type)) {
    const value = text(obj(r[type])[RULE_VALUE[type]]);
    if (value !== null) out.value = value;
  }
  return out;
}

function toAccessPolicy(raw: unknown): AccessPolicyOut {
  const p = obj(raw);
  return {
    id: text(p.id),
    name: text(p.name),
    decision: text(p.decision),
    include: list(p.include).map(toAccessRule),
    exclude: list(p.exclude).map(toAccessRule),
    require: list(p.require).map(toAccessRule),
  };
}

function toEmailRule(raw: unknown): EmailRuleOut {
  const r = obj(raw);
  return {
    name: text(r.name),
    enabled: typeof r.enabled === "boolean" ? r.enabled : null,
    priority: typeof r.priority === "number" ? r.priority : null,
    matchers: list(r.matchers).map((m) => {
      const o = obj(m);
      return { type: text(o.type), field: text(o.field), value: text(o.value) };
    }),
    actions: list(r.actions).map((a) => {
      const o = obj(a);
      return { type: text(o.type), value: texts(o.value) };
    }),
  };
}

function toEmailAddress(raw: unknown): EmailAddressOut {
  const a = obj(raw);
  // Cloudflare's verified is the time of verification, or null while unverified.
  return { email: text(a.email), verified: typeof a.verified === "string" && a.verified.length > 0 };
}

/** The zones Email Routing rules are read for: the one named, or every zone in the
 *  account the token can list. A name no zone has fails, never an empty answer. */
async function zonesFor(fetchImpl: FetchLike, token: string, account: string, zone: string | undefined): Promise<Array<{ id: string; name: string }>> {
  const url = new URL(`${CF_API}/zones`);
  url.searchParams.set("account.id", account);
  if (zone !== undefined) url.searchParams.set("name", zone);
  const raw = await readAll(fetchImpl, token, url.toString(), "the zones list", CF_PERMISSION.zones);
  const zones = raw
    .map((z) => ({ id: text(obj(z).id), name: text(obj(z).name) }))
    .filter((z): z is { id: string; name: string } => z.id !== null && z.name !== null);
  if (zone !== undefined && !zones.some((z) => z.name === zone)) {
    throw new Error(`no zone named ${zone} in the account CF_OPS_TOKEN can list.`);
  }
  return zone === undefined ? zones : zones.filter((z) => z.name === zone);
}

/** One cloudflare_config action. Credentials missing fails with what is unset, and
 *  nothing is fetched. */
export async function readCloudflareConfig(
  env: Pick<Env, "CF_OPS_TOKEN" | "CF_ACCOUNT_ID" | "R2_ACCOUNT_ID">,
  action: CfConfigAction,
  zone: string | undefined,
  fetchImpl: FetchLike
): Promise<CfConfigResult> {
  const creds = cloudflareCredentials(env);
  if (!creds.ok) throw new Error(`the Cloudflare read is not configured: ${creds.reason}.`);
  const { token } = creds;
  const account = `${CF_API}/accounts/${encodeURIComponent(creds.account)}`;
  switch (action) {
    case "access_apps": {
      const apps = (await readAll(fetchImpl, token, `${account}/access/apps`, "the Access applications list", CF_PERMISSION.access)).map(toAccessApp);
      return { action, count: apps.length, apps };
    }
    case "access_policies": {
      const policies = (await readAll(fetchImpl, token, `${account}/access/policies`, "the Access policies list", CF_PERMISSION.access)).map(toAccessPolicy);
      return { action, count: policies.length, policies };
    }
    case "email_rules": {
      const out: Array<{ zone: string; count: number; rules: EmailRuleOut[] }> = [];
      for (const z of await zonesFor(fetchImpl, token, creds.account, zone)) {
        const url = `${CF_API}/zones/${encodeURIComponent(z.id)}/email/routing/rules`;
        const rules = (await readAll(fetchImpl, token, url, `the Email Routing rules for ${z.name}`, CF_PERMISSION.rules)).map(toEmailRule);
        out.push({ zone: z.name, count: rules.length, rules });
      }
      return { action, zones: out };
    }
    case "email_addresses": {
      const addresses = (await readAll(fetchImpl, token, `${account}/email/routing/addresses`, "the Email Routing addresses list", CF_PERMISSION.addresses)).map(
        toEmailAddress
      );
      return { action, count: addresses.length, addresses };
    }
  }
  throw new Error(`unknown cloudflare_config action '${String(action)}'.`);
}
