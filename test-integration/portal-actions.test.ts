import { beforeEach, describe, expect, it } from "vitest";
import { APP_ROSTER } from "../src/roster";
import type { PortalPerformed, PortalPreview } from "../src/ops-types/portal";
import { PORTAL_ACTIONS } from "../src/controls-base";
import { PORTAL_PREVIEW_PATH } from "../src/portal-actions";
import { CSRF, ACTOR, call, auditRows, resetPortal, performToken } from "./portal-actions-fixtures";
import { CASES } from "./portal-actions-cases";

// Every action previewed, checked to have written nothing, then performed from its token and read back.

beforeEach(resetPortal);

describe("every action, previewed then performed through the Worker", () => {
  it("covers the allow-list", () => {
    expect(Object.keys(CASES).sort()).toEqual([...PORTAL_ACTIONS].sort());
  });

  for (const action of PORTAL_ACTIONS) {
    it(`${action}: the preview writes nothing, and the perform writes the rows the preview listed`, async () => {
      const params = await CASES[action].params();
      const auditBefore = await auditRows();

      const previewed = await call(PORTAL_PREVIEW_PATH, {
        method: "POST",
        body: { action, params },
      });
      expect(previewed.status, await previewed.clone().text()).toBe(200);
      const preview = (await previewed.json()) as PortalPreview;
      expect(await auditRows(), "the preview wrote an audit row").toEqual(auditBefore);

      const performed = await performToken(preview.token);
      expect(performed.status, await performed.clone().text()).toBe(200);
      const body = (await performed.json()) as PortalPerformed;
      expect(body.action).toBe(action);
      expect(body.warning).toBeNull();
      expect(body.feed.csrf).toBe(CSRF);
      expect(body.feed.live.namespaces.map((n) => n.name)).toEqual([...APP_ROSTER]);
      await CASES[action].after(params);

      // Compare distinct "<action> by <actor>" lines.
      const written = (await auditRows()).filter((r) => !auditBefore.some((b) => b.id === r.id));
      expect([...new Set(written.map((r) => `${r.action} by ${r.actor}`))].sort()).toEqual(
        [...preview.audit].sort(),
      );
      const click = written.find((r) => r.action === `portal-${action}`);
      expect(click?.actor).toBe(ACTOR);
    });
  }
});
