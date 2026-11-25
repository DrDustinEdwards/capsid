// The canary check, apart from the gate so a test can drive it (verify-live.mjs runs on import).
// It reads KV directly because /authorize shows a missing client and a KV outage as the same page; the REST status tells them apart.

/**
 * @returns {Promise<{ outcome: "present"|"missing"|"unreachable"|"corrupt"|"has-ttl"|"ttl-unverified", detail?: string, expiration?: number }>}
 */
export async function checkCanary({ fetchImpl, base, clientId, auth }) {
  const key = `client:${clientId}`;

  let resp = null;
  try {
    resp = await fetchImpl(`${base}/values/${encodeURIComponent(key)}`, { headers: auth });
  } catch (err) {
    // A thrown fetch is a network failure, not a missing record.
    return { outcome: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }

  if (!resp.ok && resp.status !== 404) {
    return { outcome: "unreachable", detail: `status=${resp.status}` };
  }

  if (resp.status === 404) return { outcome: "missing" };

  // A 200 is weaker than it looks: a truncated or foreign value also reads 200.
  const body = await resp.text().catch(() => "");
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (parsed?.clientId !== clientId) {
    return { outcome: "corrupt", detail: body.slice(0, 120) };
  }

  // Must also be non-expiring: a record put back with a TTL could expire on its own.
  // An unreadable key list is its own failing outcome.
  let entry;
  try {
    const listed = await fetchImpl(`${base}/keys?prefix=${encodeURIComponent(key)}`, {
      headers: auth,
    });
    if (!listed.ok)
      return { outcome: "ttl-unverified", detail: `key list status=${listed.status}` };
    const data = await listed.json().catch(() => null);
    if (!Array.isArray(data?.result))
      return { outcome: "ttl-unverified", detail: "the key list response carries no result array" };
    entry = data.result.find((k) => k?.name === key);
  } catch (err) {
    return { outcome: "ttl-unverified", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!entry)
    return { outcome: "ttl-unverified", detail: `${key} reads 200 but is not in the key list` };
  if (entry.expiration) return { outcome: "has-ttl", expiration: entry.expiration };

  return { outcome: "present" };
}

export function canaryReport(result, clientId, namespaceName) {
  const key = `client:${clientId}`;
  switch (result.outcome) {
    case "present":
      return { passed: true, detail: `${key} present, non-expiring, clientId matches` };
    case "missing":
      return {
        passed: false,
        detail:
          `MISSING: ${key} is GONE from ${namespaceName}. This record has no expiry and nothing in this repo deletes it, ` +
          `so this is the vanished-client-record anomaly of 2026-08-17 recurring. Every OAuth client in this keyspace is suspect; ` +
          `check whether live grants survived before restoring it (scripts/bindings.mjs, CANARY_CLIENT).`,
      };
    case "unreachable":
      return {
        passed: false,
        detail: `UNREACHABLE: could not read ${key} (${result.detail}). This is a KV or credential failure and is NOT evidence the record is gone.`,
      };
    case "corrupt":
      return {
        passed: false,
        detail: `CORRUPT: ${key} reads 200 but does not carry clientId=${clientId}. Value starts: ${result.detail}`,
      };
    case "has-ttl":
      return {
        passed: false,
        detail:
          `HAS A TTL: ${key} expires ${new Date(result.expiration * 1000).toISOString().slice(0, 10)}. ` +
          `The canary must not expire, or a normal expiry reads as data loss. Re-put the value with no expiration_ttl.`,
      };
    case "ttl-unverified":
      return {
        passed: false,
        detail: `TTL UNVERIFIED: ${key} is present and its clientId matches, but whether it expires could not be read (${result.detail}). Not reporting it as non-expiring.`,
      };
    default:
      return { passed: false, detail: `unknown canary outcome ${JSON.stringify(result.outcome)}` };
  }
}
