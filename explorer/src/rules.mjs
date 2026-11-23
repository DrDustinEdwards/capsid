// The rules the front page's build and its script share, so the page's first render and its
// interactive state cannot disagree (src/scope.ts: needFor, checkScope; src/job-claims.ts:
// evaluationRows). Pure, with no imports: build.mjs bundles explorer.js with this inlined.

/** What each grant requirement asks of a caller, in words. */
export const NEED = {
  read: "read access",
  write: "write access",
  action: "read or write access, by action",
  admin: "admin and write access",
  admin_read: "admin and read access",
};

/**
 * Whether a caller holding these grants reaches a tool: "full", "part" (an action tool, some of
 * whose actions need the grant it lacks) or "".
 * @param {string} need @param {{ read: boolean, write: boolean, admin: boolean }} held
 */
export function reaches(need, held) {
  if (need === "read") return held.read ? "full" : "";
  if (need === "write") return held.write ? "full" : "";
  if (need === "admin") return held.admin && held.write ? "full" : "";
  if (need === "admin_read") return held.admin && held.read ? "full" : "";
  if (need === "action")
    return held.read && held.write ? "full" : held.read || held.write ? "part" : "";
  return "";
}

/** How many tools a caller with these grants reaches, in words. @param {string[]} needs the grant of each tool @param {{ read: boolean, write: boolean, admin: boolean }} held */
export function reachSentence(needs, held) {
  const full = needs.filter((n) => reaches(n, held) === "full").length;
  const part = needs.filter((n) => reaches(n, held) === "part").length;
  const who =
    !held.read && !held.write && !held.admin
      ? "An agent with no access"
      : held.admin && held.read && held.write
        ? "The admin"
        : held.read && !held.write && !held.admin
          ? "A read-only agent"
          : `An agent with ${[held.read && "read", held.write && "write", held.admin && "admin"].filter(Boolean).join(" and ")} access`;
  return `${who} can use ${full} of ${needs.length} tools${part ? `, and ${part} more in part` : ""}.`;
}

/** A check's value in words: a count as itself, CI green as yes or no. @param {string} kind @param {number} n */
export const valueWords = (kind, n) => (kind === "ci_green" ? (n ? "Yes" : "No") : String(n));

/**
 * What Capsid records for a claim: GitHub's value, with the agent's beside it and the two
 * marked as agreeing or not. @param {string} kind @param {number} said @param {number} read
 */
export function verdict(kind, said, read) {
  const r = valueWords(kind, read);
  return said === read
    ? `They match. Capsid saves ${r}.`
    : `Caught. The agent said ${valueWords(kind, said)} and GitHub says ${r}. Capsid saves GitHub's answer and flags the mismatch.`;
}
