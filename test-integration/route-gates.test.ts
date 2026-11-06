import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { defaultScopes, serializeScopes } from "../src/agents-schema";
import { ROUTE_GRANTS, UNGATED_ROUTES } from "../src/scope";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";

// Every route goes through the one enforcement point, driven through the whole
// Worker: each request goes through SELF.fetch with the credential a caller would
// present.

const ORIGIN = "https://capsid.test";
const DRIVER_KEY = "capsid_agent_" + "d".repeat(64);

beforeEach(async () => {
  // A driver minted for one namespace with the write grant.
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  await env.DB.prepare("DELETE FROM agents").run();
  await env.DB.prepare(
    `INSERT INTO agents (id, name, kind, key_hash, scopes, created_by, created_at)
     VALUES ('agent_driver000001', 'capsid-driver', 'driver', ?1, ?2, 'github:dustin', '2026-09-11 00:00:00')`,
  )
    .bind(await sha256Hex(DRIVER_KEY), serializeScopes(scopes))
    .run();
});

describe("the route tables are a statement about the Worker that serves them", () => {
  const isFallback = async (r: Response) =>
    r.status === 404 && (await r.clone().text()) === "not found";

  it("every path in ROUTE_GRANTS and UNGATED_ROUTES is served by some method, so no entry is stale", async () => {
    const paths = [...Object.keys(ROUTE_GRANTS), ...Object.keys(UNGATED_ROUTES)];
    expect(paths.length, "the tables are empty, so this proves nothing").toBeGreaterThan(0);
    // The fallback is what an unserved path gets, measured rather than assumed.
    expect(await isFallback(await SELF.fetch(`${ORIGIN}/not-a-route`))).toBe(true);
    for (const path of paths) {
      const get = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      const post = await SELF.fetch(`${ORIGIN}${path}`, {
        method: "POST",
        redirect: "manual",
        body: "",
      });
      const served = !(await isFallback(get)) || !(await isFallback(post));
      expect(served, `src/scope.ts names route ${path}, which the Worker does not serve`).toBe(
        true,
      );
    }
  });

  // scanner-rule: one enforcement point invariant. Derived over UNGATED_ROUTES:
  // every /portal route but the sign-in callback answers to portalGate, so a route
  // added under /portal without it fails here.
  it("PLANT: every Portal route is behind portalGate: a bearer gets 403 and an anonymous caller the sign-in", async () => {
    const NOT_GATED = new Set(["/portal/callback"]);
    const portalRoutes = Object.keys(UNGATED_ROUTES).filter(
      (p) => p.startsWith("/portal") && !NOT_GATED.has(p),
    );
    // The feed, the refresh, preview, perform, namespaces, activity, claims, stale jobs,
    // the Merge units panel's read, a site page's search, traffic, builds and build log, the Tonight plan, the
    // digest, the Maintenance list, the convergence view, package
    // history, the completeness board, the 404 counts, the Workers' resources, the Library, the trends,
    // phone alerts, sign-out, the /portal/api/ fallback, the app and the app's files.
    expect(portalRoutes.length, `Portal routes found: ${portalRoutes.join(", ")}`).toBe(30);
    for (const path of portalRoutes) {
      for (const method of ["GET", "POST"]) {
        const bearer = await SELF.fetch(`${ORIGIN}${path}`, {
          method,
          redirect: "manual",
          headers: { Authorization: `Bearer ${DRIVER_KEY}` },
        });
        if (await isFallback(bearer)) continue; // not served for this method
        expect(bearer.status, `${method} ${path} served a bearer`).toBe(403);
        const anonymous = await SELF.fetch(`${ORIGIN}${path}`, { method, redirect: "manual" });
        expect(anonymous.status, `${method} ${path} served an anonymous caller`).toBe(302);
        expect(
          anonymous.headers.get("Location") ?? "",
          `${method} ${path} did not send an anonymous caller to the Access sign-in`,
        ).toContain("sample.cloudflareaccess.com");
      }
    }
  });

  // The Portal moved from /console with no redirects (capsid/research/
  // design-portal-unify.md): every old address, by every method, is the Worker's plain
  // fallback. Six addresses, the old page, its JSON twin and old JSON address, its
  // callback, the old feed and the old app.
  it("every old /console address is the plain 404, with no redirect", async () => {
    const OLD = [
      "/console",
      "/console/json",
      "/console.json",
      "/console/callback",
      "/console/api/ops",
      "/console/app/",
    ];
    expect(OLD.length).toBe(6);
    for (const path of OLD) {
      for (const method of ["GET", "POST"]) {
        const response = await SELF.fetch(`${ORIGIN}${path}`, { method, redirect: "manual" });
        expect(await isFallback(response), `${method} ${path} answered ${response.status}`).toBe(
          true,
        );
        expect(response.headers.get("Location"), `${method} ${path} redirects`).toBeNull();
      }
    }
    expect(
      Object.keys(UNGATED_ROUTES).filter((p) => p.startsWith("/console")),
      "src/scope.ts still names a /console route",
    ).toEqual([]);
  });
});
