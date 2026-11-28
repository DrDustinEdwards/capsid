import { onSighting, type FindingMemory, type FindingRow } from "./watcher-findings";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { owningCheck } from "./watcher-checks";
import type { Gathered } from "./watcher";

// One pass, with the IO injected. Order: gather, clear what is no longer found, record what is
// seen. Clearing first starts the quiet period of a finding that flickers off before it is seen
// again.

interface PassReaders {
  findings: () => Promise<Pick<Gathered, "findings" | "ran">>;
  memory: FindingMemory;
}

interface PassResult {
  // Opened, or seen again while open.
  recorded: string[];
  cleared: string[];
  // Seen and left as it is: dismissed, or inside the quiet period.
  held: string[];
}

// A keyed write that moved nothing lost a race with another pass (the tick and the
// Portal's Refresh). Said, not swallowed; the next pass reads the row again.
function moved(ok: boolean, fingerprint: string, what: string): void {
  if (!ok)
    logEvent(
      "WATCHER_FINDING_MOVED",
      {
        message: `WATCHER_FINDING_MOVED ${fingerprint}: the row changed between the read and the ${what}; left for the next pass`,
      },
      { level: "error" },
    );
}

export async function runPass(readers: PassReaders, now: Date): Promise<PassResult> {
  const { findings: found, ran } = await readers.findings();
  const seen = new Set(found.map((f) => f.fingerprint));
  const rows = await readers.memory.load([...seen]);

  // Absent, and the check that would find it again ran. A failed read is not
  // evidence the problem went away.
  const clearable = (fingerprint: string): boolean => {
    if (seen.has(fingerprint)) return false;
    const owner = owningCheck(fingerprint);
    return !owner || ran.has(owner);
  };

  const cleared: string[] = [];
  for (const row of rows.values()) {
    if (row.state === "cleared" || !clearable(row.fingerprint)) continue;
    const ok = await readers.memory.clear(row, now);
    moved(ok, row.fingerprint, "clear");
    if (ok) cleared.push(row.fingerprint);
  }

  const recorded: string[] = [];
  const held: string[] = [];
  for (const f of found) {
    const row: FindingRow | null = rows.get(f.fingerprint) ?? null;
    const verdict = onSighting(row, now);
    if (verdict.do === "quiet") {
      held.push(f.fingerprint);
      moved(
        await readers.memory.sight(row as FindingRow, f, now),
        f.fingerprint,
        `sighting (${verdict.why})`,
      );
      continue;
    }
    recorded.push(f.fingerprint);
    const ok = !row
      ? await readers.memory.insert(f, now)
      : row.state === "open"
        ? await readers.memory.sight(row, f, now)
        : await readers.memory.open(row, f, now);
    moved(ok, f.fingerprint, "record");
  }
  return { recorded, cleared, held };
}
