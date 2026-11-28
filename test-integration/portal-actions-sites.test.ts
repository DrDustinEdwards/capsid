import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { capsidStatus } from "../src/status";
import { APP_ROSTER } from "../src/roster";
import type {
  PortalActivity,
  PortalNamespaces,
  PortalPerformed,
  PortalPreview,
} from "../src/ops-types/portal";
import {
  PORTAL_ACTIVITY_PATH,
  PORTAL_NAMESPACES_PATH,
  PORTAL_PREVIEW_PATH,
} from "../src/portal-actions";
import {
  workerEnv,
  call,
  auditRows,
  resetPortal,
  siteRow,
  performToken,
} from "./portal-actions-fixtures";

beforeEach(resetPortal);

describe("the project actions against real D1", () => {
  it("a project delete keeps the delete tool's refusals, and a project changed after its preview is refused at perform and kept", async () => {
    await env.DB.prepare("INSERT INTO namespaces (namespace, repos) VALUES ('sample-kept', ?1)")
      .bind(JSON.stringify([{ repo: "example/sample-kept", label: "primary" }]))
      .run();
    await env.DB.prepare(
      "INSERT INTO documents (namespace, path, title, body) VALUES ('sample-kept', 'notes.md', 'Notes', 'lorem')",
    ).run();
    const auditBefore = await auditRows();
    const refused = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: { action: "namespace_remove", params: { namespace: "sample-kept" } },
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/Pass cascade: true to delete them/);

    const preview = (await (
      await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action: "namespace_remove", params: { namespace: "sample-kept", cascade: "true" } },
      })
    ).json()) as PortalPreview;
    await env.DB.prepare(
      "INSERT INTO documents (namespace, path, title, body) VALUES ('sample-kept', 'later.md', 'Later', 'ipsum')",
    ).run();
    const res = await performToken(preview.token);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/changed since the preview/);
    expect(
      await env.DB.prepare(
        "SELECT namespace FROM namespaces WHERE namespace = 'sample-kept'",
      ).first(),
    ).not.toBeNull();
    expect(await auditRows(), "a refused delete wrote a row").toEqual(auditBefore);
  });
});

describe("the site actions against real D1", () => {
  it("a site edit previewed, then edited elsewhere, is refused at perform and the row keeps the other edit", async () => {
    const row = await siteRow("foxing");
    const params = {
      namespace: "foxing",
      revision: String(row?.revision),
      name: "Foxing",
      origin: "https://foxing.app",
      health_path: "/api/health",
      platform: "cloudflare",
    };
    const preview = (await (
      await call(PORTAL_PREVIEW_PATH, { method: "POST", body: { action: "site_edit", params } })
    ).json()) as PortalPreview;
    await env.DB.prepare(
      "UPDATE ops_sites SET name = 'Foxing (renamed)', revision = revision + 1 WHERE namespace = 'foxing'",
    ).run();
    const res = await performToken(preview.token);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/changed since the preview/);
    expect(await siteRow("foxing")).toMatchObject({
      name: "Foxing (renamed)",
      health_path: "/health",
    });
    expect(
      (await auditRows()).some((r) => r.action === "portal-site_edit"),
      "a refused edit wrote a click row",
    ).toBe(false);
  });

  it("add refuses an unregistered namespace and a bad origin at preview, with the reason, writing nothing", async () => {
    const auditBefore = await auditRows();
    const unregistered = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: {
        action: "site_add",
        params: {
          namespace: "nobody",
          origin: "https://nobody.example.com",
          platform: "cloudflare",
        },
      },
    });
    expect(unregistered.status).toBe(400);
    expect(await unregistered.text()).toMatch(/neither a registered namespace nor a further host/);
    // A further host of a registered namespace (<namespace>-<host>) is a site row the watcher accepts.
    const host = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: {
        action: "site_add",
        params: {
          namespace: "sample-mcp",
          origin: "https://mcp.sample.example.com",
          platform: "cloudflare",
        },
      },
    });
    expect(host.status).toBe(200);
    const http = await call(PORTAL_PREVIEW_PATH, {
      method: "POST",
      body: {
        action: "site_add",
        params: {
          namespace: "sample",
          origin: "http://sample.example.com",
          platform: "cloudflare",
        },
      },
    });
    expect(http.status).toBe(400);
    expect(await http.text()).toMatch(/must start with https/);
    expect(await siteRow("sample")).toBeNull();
    expect(await auditRows()).toEqual(auditBefore);
  });

  it("the feed carries the configuration, and a perform's feed shows the change", async () => {
    const row = await siteRow("julieedwards");
    const preview = (await (
      await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: {
          action: "site_remove",
          params: { namespace: "julieedwards", revision: String(row?.revision) },
        },
      })
    ).json()) as PortalPreview;
    expect(preview.changes.join(" ")).toMatch(/still registered|remove julieedwards/);
    const performed = (await (await performToken(preview.token)).json()) as PortalPerformed;
    expect(performed.feed.live.sites.some((s) => s.namespace === "julieedwards")).toBe(false);
    expect(performed.feed.live.sites.some((s) => s.namespace === "capsid")).toBe(true);
  });
});

describe("the Portal's reads", () => {
  it("namespaces reports what the status reports, for every roster namespace", async () => {
    const response = await call(PORTAL_NAMESPACES_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as PortalNamespaces;
    expect(body.namespaces.map((n) => n.namespace)).toEqual([...APP_ROSTER]);
    const status = await capsidStatus(workerEnv());
    for (const ns of status.namespaces) {
      const served = body.namespaces.find((n) => n.namespace === ns.namespace)!;
      expect(served.latest_report?.integrity ?? null).toBe(ns.latest_report?.integrity ?? null);
    }
  });

  it("activity is the filtered, bounded audit read, newest first, with ISO times", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'sample', 'a.md', '{}')",
      ),
      env.DB.prepare(
        "INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:other', 'write', 'sample', 'b.md', '{}')",
      ),
      env.DB.prepare(
        "INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'capsid', 'c.md', '{}')",
      ),
    ]);
    const response = await call(`${PORTAL_ACTIVITY_PATH}?namespace=sample&actor=agent:sample`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PortalActivity;
    expect(body.filter).toEqual({ namespace: "sample", actor: "agent:sample", id: null });
    expect(body.limit).toBe(50);
    expect(body.rows.map((r) => r.path)).toEqual(["a.md"]);
    expect(body.rows[0].at).toMatch(/T.*Z$/);
    const all = (await (await call(PORTAL_ACTIVITY_PATH)).json()) as PortalActivity;
    expect(all.rows.map((r) => r.path)).toEqual(["c.md", "b.md", "a.md"]);

    const one = (await (
      await call(`${PORTAL_ACTIVITY_PATH}?id=${all.rows[1]!.id}`)
    ).json()) as PortalActivity;
    expect(one.filter.id).toBe(all.rows[1]!.id);
    expect(one.rows.map((r) => r.path)).toEqual(["b.md"]);
    expect(one.rows[0]!.detail).toEqual({
      reason: null,
      changes: null,
      fields: [],
      withheld: 0,
      unreadable: false,
    });
    expect(Object.keys(one.rows[0]!)).not.toContain("params");
  });

  it("an activity id that is not a row id is refused with 400, never read as no filter", async () => {
    const response = await call(`${PORTAL_ACTIVITY_PATH}?id=1%20OR%201=1`);
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/^id must be an audit row id/);
  });
});
