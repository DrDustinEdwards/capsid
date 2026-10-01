import { exactTime } from "../lib/format";

// An exact time in a panel or a detail field: the viewer's zone, then UTC beside it, in
// a <time> element, readable without a hover (ruled 2026-09-30, DECIDE 13).
export function When({ t, className }: { t: number; className?: string }) {
  const e = exactTime(t);
  if (!e.iso) return <span className={className}>{e.local}</span>;
  return (
    <time dateTime={e.iso} className={`when num${className ? ` ${className}` : ""}`}>
      {e.local} <span className="faint">({e.utc})</span>
    </time>
  );
}
