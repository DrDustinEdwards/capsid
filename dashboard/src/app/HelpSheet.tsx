import { useEffect, useRef } from "react";
import type { ViewDef, ViewId } from "./ctx";

// What each view is for, in a line. These were the intro sentences under each view's
// heading (design D13 moved them here). CI and merges has none: its intro only restated
// its name.
const ABOUT: Partial<Record<ViewId, string>> = {
  overview: "Problems first, worst first; then the sites and the week of deploys.",
  sites: "Health comes from each site's own route; a root 200 is liveness, not health.",
  incidents: "Watcher findings, open first. Each is posted once and clears on its own.",
  queue: "A blocked job shows what it waits on; open it for the command and the resume call.",
  deploys: "From Cloudflare's own record, so a hand-run wrangler deploy shows up too.",
  agents: "Every credential and when it was last seen. Verified columns are what the Worker checked against GitHub.",
  backups: "The nightly dump and the off-account mirror. A stale dump or a dead mirror is red on purpose.",
  namespaces: "The automation switches, then each roster namespace with its switch. A switch asks for a reason and offers Undo.",
  activity: "The audit log, newest first: who did what, where.",
  claims: "What each agent said beside what the Worker verified. A field not stated is never zero.",
  packages: "Each package configured in Settings: its versions, downloads, dependents and repository.",
  settings: "The sites the watcher probes and the npm packages it reads. Every change is previewed first.",
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
