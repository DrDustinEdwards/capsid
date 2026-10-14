import { useCallback, useRef, useState } from "react";

// The content-box width of an element, kept current as the layout changes (the window,
// the rail collapsing).
export function useWidth(): [number | null, (el: HTMLElement | null) => void] {
  const [w, setW] = useState<number | null>(null);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setW(e.contentRect.width);
    });
    ro.observe(el);
    obs.current = ro;
  }, []);
  return [w, ref];
}
