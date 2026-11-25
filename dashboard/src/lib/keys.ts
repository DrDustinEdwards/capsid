export const FILTER_KEYS = ["namespace", "agent", "since", "until"] as const;

export const PUSH_KEY = ["push"];

export function parseDocParam(value: string | null): { ns: string; path: string } | null {
  if (!value) return null;
  const i = value.indexOf("/");
  if (i <= 0 || i === value.length - 1) return null;
  return { ns: value.slice(0, i), path: value.slice(i + 1) };
}
