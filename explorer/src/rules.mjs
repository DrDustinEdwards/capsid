// Shared by the front page's build and its script so the first render and the interactive state cannot disagree
// (src/scope.ts needFor, checkScope; src/job-claims.ts evaluationRows). Pure: build.mjs bundles explorer.js with this inlined.

export const NEED = {
  read: "read access",
  write: "write access",
  action: "read or write access, by action",
  admin: "admin and write access",
  admin_read: "admin and read access",
};

// "full", "part" (an action tool, some of whose actions need the grant it lacks) or "".
/** @param {string} need @param {{ read: boolean, write: boolean, admin: boolean }} held */
export function reaches(need, held) {
  if (need === "read") return held.read ? "full" : "";
  if (need === "write") return held.write ? "full" : "";
  if (need === "admin") return held.admin && held.write ? "full" : "";
  if (need === "admin_read") return held.admin && held.read ? "full" : "";
  if (need === "action")
    return held.read && held.write ? "full" : held.read || held.write ? "part" : "";
  return "";
}

/** @param {string[]} needs @param {{ read: boolean, write: boolean, admin: boolean }} held */
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

/** @param {string} kind @param {number} n */
export const valueWords = (kind, n) => (kind === "ci_green" ? (n ? "Yes" : "No") : String(n));

/** @param {string} kind @param {number} said @param {number} read */
export function verdict(kind, said, read) {
  const r = valueWords(kind, read);
  return said === read
    ? `They match. Capsid saves ${r}.`
    : `Caught. The agent said ${valueWords(kind, said)} and GitHub says ${r}. Capsid saves GitHub's answer and flags the mismatch.`;
}
