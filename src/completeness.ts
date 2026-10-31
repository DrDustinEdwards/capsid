import { z } from "zod";
import type { Env } from "./env";
import { ghFetch } from "./github/client";
import { bounded } from "./limits";
import type { CompletenessView } from "./ops-types/feed";

// THE COMPLETENESS SCOREBOARD, read for the Portal (GET /portal/api/completeness). devkit's
// daily live run (devkit .github/workflows/live.yml, bin/live.mjs) writes board.json to its
// orphan `scoreboard` branch: every area of the shared code against the package and every
// live site, each cell filled only from the live checks and the verifiers' verdicts. The
// rules that decide a cell are devkit's; Capsid only reads the board through the GitHub App
// and shows it, so a thread cannot mark itself complete here either.
//
// The board is a public repo's file, read as data: parsing keeps only the fields named
// below, bounded, and a link that is not https is dropped. Kept ten minutes in KV, since the
// board changes once a day and on a merged verdict.

const OWNER = "DrDustinEdwards";
const REPO = "devkit";
const BRANCH = "scoreboard";
const FILE = "board.json";
const MAX_FILE_BYTES = 2_000_000;
export const COMPLETENESS_CACHE_KEY = "portal:completeness:v1";
const CACHE_TTL_SECONDS = 600;
const MAX_ERRORS_SHOWN = 5;

const Text = (max: number) => bounded(max).catch("");
const Https = bounded(2000).regex(/^https:\/\//);

const CellSchema = z.object({
  status: z.enum(["complete", "partial", "missing", "n/a"]),
  reason: Text(600),
  evidence: z.array(z.unknown()).max(50).optional(),
  clean_days: z.number().int().min(0).optional(),
  findings: z.array(z.object({ severity: bounded(20), check: Text(200), detail: Text(600) })).max(500).optional(),
});

const BoardSchema = z.object({
  as_of: bounded(40).nullable(),
  finished: z.boolean(),
  public_token: z.boolean().optional(),
  sites: z.array(z.object({ id: bounded(64), name: bounded(120), origin: Https })).max(100),
  areas: z
    .array(
      z.object({
        id: z.number().int().min(1).max(99),
        name: bounded(200),
        builder: bounded(200),
        verifier: bounded(200).nullable(),
        lines: z.union([z.object({ prs: z.number().int().min(0), added: z.number().int().min(0), removed: z.number().int().min(0) }), z.object({ error: Text(300) })]).nullable(),
        cells: z.record(bounded(64), CellSchema),
      })
    )
    .max(50),
});

/** The board as the Portal shows it, from devkit's parsed board.json. Pure. */
function completenessView(raw: unknown, now: Date): CompletenessView {
  const parsed = BoardSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return emptyView(now, `devkit's board.json is not the shape Capsid reads (${issues})`);
  }
  const board = parsed.data;
  return {
    read: now.toISOString(),
    as_of: board.as_of,
    error: null,
    finished: board.finished,
    public_token: board.public_token ?? true,
    sites: board.sites,
    areas: board.areas.map((area) => ({
      ...area,
      cells: Object.fromEntries(
        Object.entries(area.cells).map(([id, cell]) => [
          id,
          {
            status: cell.status,
            reason: cell.reason,
            evidence: (cell.evidence ?? []).filter((url): url is string => Https.safeParse(url).success),
            clean_days: id === "package" ? null : (cell.clean_days ?? null),
            errors: (cell.findings ?? []).filter((f) => f.severity === "error").slice(0, MAX_ERRORS_SHOWN).map(({ check, detail }) => ({ check, detail })),
          },
        ])
      ),
    })),
  };
}

const emptyView = (now: Date, error: string): CompletenessView => ({ read: now.toISOString(), as_of: null, error, finished: false, public_token: true, sites: [], areas: [] });

/** The view, from the ten minutes' cache unless `fresh`. A board that cannot be read says why. */
export async function readCompleteness(env: Env, now: Date, fresh = false): Promise<CompletenessView> {
  if (!fresh) {
    const cached = await env.APP_KV.get(COMPLETENESS_CACHE_KEY);
    if (cached) return JSON.parse(cached) as CompletenessView;
  }
  let raw: unknown;
  try {
    const resp = await ghFetch(env, OWNER, REPO, `/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${BRANCH}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (resp.status === 404) return emptyView(now, "devkit has no scoreboard yet: its live workflow has not published board.json");
    if (!resp.ok) return emptyView(now, `GitHub answered ${resp.status} for devkit's board.json`);
    const text = await resp.text();
    if (text.length > MAX_FILE_BYTES) return emptyView(now, `devkit's board.json is ${text.length} bytes, over ${MAX_FILE_BYTES}`);
    raw = JSON.parse(text);
  } catch (err) {
    return emptyView(now, `devkit's board.json could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const view = completenessView(raw, now);
  if (!view.error) await env.APP_KV.put(COMPLETENESS_CACHE_KEY, JSON.stringify(view), { expirationTtl: CACHE_TTL_SECONDS });
  return view;
}
