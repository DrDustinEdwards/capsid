// The remembered theme, set before the first paint so the page never flashes the other one
// (Capsomer's theme-switch, "Applied before first paint"). A file, not an inline script, so the
// policy needs no hash. With nothing remembered the system's setting applies. It also marks the
// page as scripted before the first paint, so what script adds (the panel's breakers) is laid out
// from the start and moves nothing when the module runs.
document.documentElement.classList.add("js");
try {
  const t = localStorage.getItem("cap-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch {}
