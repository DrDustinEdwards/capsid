import { useEffect, useRef } from "react";
import { enhance } from "capsomer/behavior/anchor-bar";
import "capsomer/anchor-bar.css";

// "On this page": Capsomer's anchor bar, which fills its own list from the page's
// [data-section] blocks and shows itself only on a view with three or more sections taller
// than two screens. Render it as the first child of the view's page element.
export function Anchors() {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => (bar.current ? enhance(bar.current.parentElement ?? document) : undefined), []);
  return (
    <nav ref={bar} className="cap-anchors" aria-label="On this page" data-cap="anchor-bar" hidden>
      <span className="cap-anchors-label" aria-hidden="true">
        On this page
      </span>
      <ul className="cap-anchors-list" />
    </nav>
  );
}
