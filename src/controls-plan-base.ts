// bind: params the plan itself adds to the token, beside the caller's, so the perform carries out
// what this preview read (sign_policy_from_repo binds its source sha this way).
export type Plan =
  | { ok: true; changes: string[]; audit: string[]; bind?: Record<string, string> }
  | { ok: false; refusal: string };

export function shown(value: string | null): string {
  return value === null ? "(none)" : `"${value}"`;
}

export const refused = (refusal: string): Plan => ({ ok: false, refusal });
