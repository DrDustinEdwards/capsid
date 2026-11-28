// capsid/policy/ holds what this Worker reads as authority (capsid/policy/live-checks.md says which
// live checks run each watcher pass).
export const POLICY_PREFIX = "policy/";

// The ordinary write tools refuse a policy document: it decides what this Worker does without a
// human, so a write there is a ruling.
export function policyWriteRefusal(namespace: string, path: string, allow: boolean): string | null {
  if (allow || namespace !== "capsid" || !path.startsWith(POLICY_PREFIX)) return null;
  return `${namespace}/${path} is an autonomy policy document. It decides what this Worker may do without a human, so a write here is a ruling. Pass allow_policy_paths: true to write it anyway; the flag needs the can_touch_protected scope and is audit-logged.`;
}
