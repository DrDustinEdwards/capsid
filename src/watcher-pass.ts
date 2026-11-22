import {
  CLEARED_SUMMARY,
  onSighting,
  type FindingMemory,
  type FindingRow,
  type SightingVerdict,
} from "./watcher-findings";
import { logEvent } from "@dustinedwards/site-runtime/log";
import type { Finding } from "./watcher-detect";
import { owningCheck, findingClass, type FindingClass } from "./watcher-checks";
import type { Gathered } from "./watcher";

// How many findings one pass will post. If every check fires at once, the queue gets
// ten jobs and the rest are found again next pass, which is better than a tick that
// posts fifty and times out.
export const MAX_FINDINGS_PER_PASS = 10;

// One pass, with the IO injected. Order: gather, clear what is no longer found, post
// what is new. Clearing first stops a finding that flickers off and on being refused
// as a duplicate of the job about to be closed.

interface PassReaders {
  findings: () => Promise<Pick<Gathered, "findings" | "ran">>;
  open: () => Promise<Map<string, string>>;
  clear: (id: string, summary?: string) => Promise<boolean>;
  post: (f: Finding) => Promise<{ ok: true; jobId: string } | { ok: false; refusal?: string }>;
  memory: FindingMemory;
}

interface PassResult {
  posted: string[];
  cleared: string[];
  // Seen and not filed: dismissed by a person, or inside the quiet period.
  held: string[];
  // Digest or attention class, recorded in finding memory with no job.
  routed: string[];
}

const movedSummary = (klass: FindingClass): string =>
  `${CLEARED_SUMMARY}: moved to ${klass === "digest" ? "the weekly digest" : "the Portal's attention list"}, no job needed`;

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
  const byFingerprint = new Map(found.map((f) => [f.fingerprint, f]));
  const open = await readers.open();
  const rows = await readers.memory.load(found.map((f) => f.fingerprint));

  // Absent, and the check that would find it again ran. A failed read is not
  // evidence the problem went away.
  const clearable = (fingerprint: string): boolean => {
    if (byFingerprint.has(fingerprint)) return false;
    const owner = owningCheck(fingerprint);
    return !owner || ran.has(owner);
  };

  const cleared: string[] = [];
  // Non-job findings whose old job was cleared this pass, and those whose job the clear
  // refused (claimed, blocked, parked): the second stay attached to their job.
  const movedOff = new Set<string>();
  const stillHeld = new Map<string, string>();
  for (const [fingerprint, id] of open) {
    // A still-found finding whose class is not job: its queued job is noise now, cleared
    // the way a gone finding is, with a summary saying where it went.
    const klass = byFingerprint.has(fingerprint) ? findingClass(fingerprint) : "job";
    if (klass !== "job") {
      if (await readers.clear(id, movedSummary(klass))) {
        cleared.push(fingerprint);
        movedOff.add(fingerprint);
      } else stillHeld.set(fingerprint, id);
      continue;
    }
    if (!clearable(fingerprint)) continue;
    if (await readers.clear(id)) cleared.push(fingerprint);
  }
  // The rows follow whether or not a job moved: a job a driver has claimed stays with
  // its driver, and the finding is cleared all the same. A dismissed finding that stops
  // being seen clears the same way, and its quiet period starts now.
  for (const row of rows.values()) {
    if (row.state === "cleared" || !clearable(row.fingerprint)) continue;
    moved(await readers.memory.clear(row, now), row.fingerprint, "clear");
  }

  const posted: string[] = [];
  const held: string[] = [];
  const routed: string[] = [];
  // The verdicts that record without posting, the same for every class: false for "post".
  // A bump is the deduplication working: counted rather than posted and refused, so the log
  // does not fill with refusals every pass while it persists.
  const recordSighting = async (
    verdict: SightingVerdict,
    row: FindingRow | null,
    f: Finding,
  ): Promise<boolean> => {
    if (verdict.do === "bump")
      moved(await readers.memory.sight(row as FindingRow, f, now), f.fingerprint, "sighting");
    else if (verdict.do === "adopt")
      moved(
        row
          ? await readers.memory.open(row, f, verdict.jobId, now)
          : await readers.memory.insert(f, "open", verdict.jobId, now),
        f.fingerprint,
        "adoption of its open job",
      );
    else if (verdict.do === "dismiss") {
      held.push(f.fingerprint);
      moved(await readers.memory.dismiss(row as FindingRow, f, now), f.fingerprint, "dismissal");
    } else if (verdict.do === "quiet") {
      held.push(f.fingerprint);
      moved(
        await readers.memory.sight(row as FindingRow, f, now),
        f.fingerprint,
        `sighting (${verdict.why})`,
      );
    } else return false;
    return true;
  };
  for (const f of found) {
    const row: FindingRow | null = rows.get(f.fingerprint) ?? null;
    if (findingClass(f.fingerprint) !== "job") {
      // Recorded for the Portal and the digest, never filed. Open with no job; a row
      // still pointing at a job from before the class existed is pointed at none once
      // that job is gone. A person's dismissal and the quiet period hold as they do for
      // a job-class finding (onSighting).
      routed.push(f.fingerprint);
      const heldJob = stillHeld.get(f.fingerprint) ?? null;
      const justMoved = movedOff.has(f.fingerprint) && row?.state === "open";
      const rowJob =
        !heldJob && !justMoved && row?.state === "open" && row.job_id
          ? await readers.memory.job(row.job_id)
          : null;
      const verdict = justMoved ? ({ do: "post" } as const) : onSighting(row, heldJob, rowJob, now);
      if (!(await recordSighting(verdict, row, f))) {
        const ok = !row
          ? await readers.memory.insert(f, "open", null, now)
          : row.state === "open" && row.job_id === null
            ? await readers.memory.sight(row, f, now)
            : await readers.memory.open(row, f, null, now);
        moved(ok, f.fingerprint, "record of a finding with no job");
      }
      continue;
    }
    const openJob = open.get(f.fingerprint) ?? null;
    // How the row's job ended, read only when the decision turns on it.
    const rowJob =
      !openJob && row?.state === "open" && row.job_id ? await readers.memory.job(row.job_id) : null;
    const verdict = onSighting(row, openJob, rowJob, now);
    if (!(await recordSighting(verdict, row, f))) {
      // The bound on posts per pass. The rest are found again next pass.
      if (posted.length >= MAX_FINDINGS_PER_PASS) continue;
      const result = await readers.post(f);
      if (result.ok) {
        posted.push(f.fingerprint);
        moved(
          row
            ? await readers.memory.open(row, f, result.jobId, now)
            : await readers.memory.insert(f, "open", result.jobId, now),
          f.fingerprint,
          "record of its new job",
        );
      } else {
        logEvent(
          "WATCHER_POST_REFUSED",
          {
            message: `WATCHER_POST_REFUSED ${f.fingerprint}: ${result.refusal ?? "no reason given"}`,
          },
          { level: "error" },
        );
        if (row) moved(await readers.memory.sight(row, f, now), f.fingerprint, "sighting");
      }
    }
  }
  return { posted, cleared, held, routed };
}
