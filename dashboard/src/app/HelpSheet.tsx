import { useEffect, useRef } from "react";
import { VIEWS } from "./ctx";

export function HelpSheet({ open, onClose, singleKeys, setSingleKeys }: { open: boolean; onClose: () => void; singleKeys: boolean; setSingleKeys: (v: boolean) => void }) {
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
          {VIEWS.map((v) => (
            <FragmentRow key={v.id} k={v.key} label={v.label} />
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
            <kbd>f</kbd>
          </dt>
          <dd>Filter the queue</dd>
          <dt>
            <kbd>?</kbd>
          </dt>
          <dd>This sheet</dd>
        </dl>
        <label>
          <input type="checkbox" checked={singleKeys} onChange={(e) => setSingleKeys(e.target.checked)} /> Single-key shortcuts (turn off if they clash with a screen reader)
        </label>
        <div className="toolbar">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

function FragmentRow({ k, label }: { k: string; label: string }) {
  return (
    <>
      <dt>
        <kbd>g</kbd> <kbd>{k}</kbd>
      </dt>
      <dd>{label}</dd>
    </>
  );
}
