import { useEffect, useRef } from "react";
import type { ViewDef, ViewId } from "./ctx";

// What each view is for, in a line. These were the intro sentences under each view's
// heading (design D13 moved them here). CI and merges has none: its intro only restated
// its name.
const ABOUT: Partial<Record<ViewId, string>> = {
  needs: "The home: what waits on you, per app, then every problem worst first.",
  queue: "A blocked job shows what it waits on; open it for the command and the resume call.",
  prs: "The pull requests waiting for you, with Approve and Close, then those recorded against jobs.",
  health: "The tiles, then sites, findings, deploys, backups and CI. Deploys are from Cloudflare's own record, so a hand-run wrangler deploy shows up too.",
  activity: "The audit log, newest first: who did what, where.",
  agents: "Every credential and when it was last seen; Claims sets what each agent said beside what the Worker verified.",
  packages: "Each package configured in Settings: its versions, downloads, dependents and repository.",
  shared: "Each shared package, the tag each app pins, who is behind, and the local copies left.",
  library: "The knowledge store, read-only: decisions, rulings and research, a search, and each document with its links and jobs.",
  settings: "The sites and packages, then the automation switches and each roster namespace. Every change is previewed first.",
};
import { Switch } from "../ui/Switch";

export function HelpSheet({ open, onClose, views, singleKeys, setSingleKeys }: { open: boolean; onClose: () => void; views: ReadonlyArray<ViewDef>; singleKeys: boolean; setSingleKeys: (v: boolean) => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={dlg} className="help" aria-labelledby="helpTitle" onClose={onClose} onClick={(e) => e.target === dlg.current && onClose()}>
      <div className="card">
        <h2 id="helpTitle">Keyboard</h2>
        <dl>
          <dt>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </dt>
          <dd>
            Command menu (also <kbd>/</kbd>)
          </dd>
          {views.map((v) => (
            <FragmentRow key={v.id} k={v.key} label={v.label} about={ABOUT[v.id]} />
          ))}
          <dt>
            <kbd>j</kbd> <kbd>k</kbd>
          </dt>
          <dd>Move through the list on screen</dd>
          <dt>
            <kbd>Enter</kbd>
          </dt>
          <dd>Open the selected row</dd>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>Close the drawer or menu</dd>
          <dt>
            <kbd>r</kbd>
          </dt>
          <dd>Refresh now</dd>
          <dt>
            <kbd>t</kbd>
          </dt>
          <dd>Switch light and dark</dd>
          <dt>
            <kbd>[</kbd>
          </dt>
          <dd>Collapse or expand the side menu</dd>
          <dt>
            <kbd>f</kbd>
          </dt>
          <dd>Filter the queue</dd>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>This sheet</dd>
        </dl>
        <div className="prefrow">
          <Switch id="help-single-keys" label="Single-key shortcuts" checked={singleKeys} onClick={() => setSingleKeys(!singleKeys)} />
          <span>
            Single-key shortcuts <span className="faint">(turn off if they clash with a screen reader; applies at once)</span>
          </span>
        </div>
        <div className="toolbar">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

function FragmentRow({ k, label, about }: { k: string; label: string; about?: string }) {
  return (
    <>
      <dt>
        <kbd>g</kbd> <kbd>{k}</kbd>
      </dt>
      <dd>
        {label}
        {about && <span className="about">{about}</span>}
      </dd>
    </>
  );
}
