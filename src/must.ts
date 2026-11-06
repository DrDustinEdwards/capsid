/**
 * The value, or a thrown error when it is null or undefined. For a value the code has already established is there
 * (a regex group after a match, a Map entry after `has`, an array element after a length check) and a test reading a
 * result it has just asserted exists: the type narrows, and a broken assumption fails here with a name instead of as a
 * TypeError somewhere later. Not a non-null assertion (`!`), which the shared lint config forbids because it checks nothing.
 */
export function must<T>(value: T, what = "value"): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be set`);
  return value as NonNullable<T>;
}
