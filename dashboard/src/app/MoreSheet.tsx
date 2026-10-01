import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { NavIcon } from "../ui/icons";
import { routePath, type ViewId } from "./ctx";

export interface MoreItem {
  id: ViewId;
  label: string;
  // "1 paused": what the rail's count says, or nothing.
  count: string | null;
  current: boolean;
}

// The phone tab bar's More (ruled 2026-09-30, DECIDE 12): every view the five tabs have
// no room for, as links with their counts. A native modal dialog, so Esc closes it and
// the app hands focus back to More.
export function MoreSheet({ open, onClose, items }: { open: boolean; onClose: () => void; items: MoreItem[] }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={dlg} className="help more" aria-labelledby="moreTitle" onClose={onClose} onClick={(e) => e.target === dlg.current && onClose()}>
      <div className="card">
        <h2 id="moreTitle">More views</h2>
        <nav aria-labelledby="moreTitle">
          <ul className="morelist">
            {items.map((v) => (
              <li key={v.id}>
                <Link href={routePath(v.id)} aria-current={v.current ? "page" : undefined} onClick={onClose}>
                  <NavIcon id={v.id} size={18} />
                  <span className="grow">{v.label}</span>
                  {v.count && <span className="faint num">{v.count}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="toolbar">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function MoreIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}
