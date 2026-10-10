import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { anomalyFindings, readActionHours } from "../src/anomaly";
import { WATCHER_ACTOR } from "../src/watcher";

// The anomaly read against a real D1: audit_log's datetime format grouped by hour, the
// window, and the actors it leaves out (the watcher, the admin). Sample actors only.

const NOW = new Date();
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString().slice(0, 19).replace("T", " ");

async function audit(actor: string, action: string, hoursAgo: number, times = 1) {
  for (let i = 0; i < times; i++) {
    await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params, at) VALUES (?1, ?2, 'sample', NULL, '{}', ?3)").bind(actor, action, at(hoursAgo)).run();
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
});

describe("the anomaly read", () => {
  it("groups agent rows by hour inside the window, leaves out the watcher, the admin and older rows, and finds a new action", async () => {
    for (const h of [40, 100, 200]) await audit("agent:sample-driver", "write", h, 2);
    await audit("agent:sample-driver", "delete_namespace", 2);
    await audit(WATCHER_ACTOR, "post", 2, 5);
    await audit("access:admin@example.com", "delete_namespace", 2);
    await audit("agent:sample-driver", "revoke", 24 * 20);
    const rows = await readActionHours(env.DB, NOW, WATCHER_ACTOR);
    expect(rows.every((r) => r.actor === "agent:sample-driver"), JSON.stringify(rows)).toBe(true);
    expect(rows.reduce((s, r) => s + r.n, 0), "three baseline hours of two rows, and the new action").toBe(7);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(r.hour))).toBe(true);
    expect(anomalyFindings(rows, NOW).map((f) => f.fingerprint)).toEqual(["anomaly-new-action-sample-driver-delete-namespace"]);
  });
});
