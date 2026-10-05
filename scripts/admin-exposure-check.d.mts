// Types for the admin-exposure check, so tests type-check under tsconfig.test.json.
// The runtime is scripts/admin-exposure-check.mjs.
export const ADMIN_URL: RegExp;
export function seatKeyPath(home?: string): string;
export function classify(text: string): { servers_seen: number; admin_servers: string[] };
export function checkAdminExposure(opts: {
  cwd: string;
  run?: (cwd: string) => { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error };
  exists?: (path: string) => boolean;
  home?: string;
}): { ok: boolean; servers_seen: number; admin_servers: string[]; seat_key_present: boolean; reasons: string[] };
