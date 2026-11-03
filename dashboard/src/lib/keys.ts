// Values the views and the server's reads (server/prefetch.ts) share, so a read made on the
// server lands under the key the view asks for.

/** The Claims filter's fields, in the order its query key joins them (views/Claims.tsx). */
export const FILTER_KEYS = ["namespace", "agent", "since", "until"] as const;

/** Phone alerts' read (views/PhoneAlerts.tsx). */
export const PUSH_KEY = ["push"];

export function parseDocParam(value: string | null): { ns: string; path: string } | null {
  if (!value) return null;
  const i = value.indexOf("/");
  if (i <= 0 || i === value.length - 1) return null;
  return { ns: value.slice(0, i), path: value.slice(i + 1) };
}
